/**
 * Transactions on a remote libSQL server: in-process serialization, the 5 s write-lock
 * steal (the server rolls back a transaction that holds the lock for more than 5 s while
 * another writer waits), stream expiry, and why statements after a failure must never be
 * sent (over HTTP they would run, and commit, outside the rolled-back transaction).
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibsqlDatabase, LibsqlExecutor } from '@/server/db/libsql';
import { classifySqlError } from '@/server/db/sql-errors';
import {
  DatabaseMisuseError,
  runInTransaction,
  runWrite,
  TransactionAbortedError,
} from '@/server/db/transaction';

import { createItemsTables, insertItem, itemNames } from '@tests/support/libsql';

import { openRemote, rawRemoteClient, wipeRemoteDatabase } from './support';

/** Longer than the server's 5 s write-lock timeout. */
const PAST_LOCK_TIMEOUT_MS = 6_000;
/** Longer than the server's (about 10 s) stream idle timeout. */
const PAST_STREAM_EXPIRY_MS = 12_000;

let handle: LibsqlDatabase;

beforeAll(async () => {
  await wipeRemoteDatabase();
  handle = await openRemote();
  await createItemsTables(handle.db);
});

beforeEach(async () => {
  await handle.db.run(sql`DELETE FROM items`);
  await handle.db.run(sql`INSERT OR REPLACE INTO counter VALUES (1, 0)`);
  // Retries are logged as warnings; keep the output readable.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterAll(() => {
  handle.close();
});

function names(db: LibsqlExecutor = handle.db): Promise<string[]> {
  return itemNames(db);
}

describe('remote transactions', () => {
  it("serialize this process's concurrent read-modify-write transactions", async () => {
    const other = await openRemote();
    try {
      expect(other.writeLock).toBe(handle.writeLock);
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          runInTransaction(i % 2 === 0 ? handle.db : other.db, async (tx) => {
            const [row] = await tx.all<{ n: number }>(sql`SELECT n FROM counter WHERE id = 1`);
            await tx.run(sql`UPDATE counter SET n = ${(row?.n ?? 0) + 1} WHERE id = 1`);
          }),
        ),
      );
      expect(await handle.db.all(sql`SELECT n FROM counter`)).toEqual([{ n: 10 }]);
    } finally {
      other.close();
    }
  });

  it('reject root-database use inside the callback instead of stalling on our own lock', async () => {
    const started = Date.now();
    const error = await runInTransaction(handle.db, async (tx) => {
      await insertItem(tx, 'inside');
      await insertItem(handle.db, 'outside'); // remotely: waits for our own write lock, then a 5 s steal
    }).catch((caught: unknown) => caught);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(String(error)).toMatch(/Failed query/);
    expect((error as Error).cause).toBeInstanceOf(DatabaseMisuseError);
    expect(await names()).toEqual([]);
  });

  it('run a batch atomically in one round trip', async () => {
    const failure = await runWrite(handle.db, (db) =>
      db.batch([
        db.run(sql`INSERT INTO items (name) VALUES ('a')`),
        db.run(sql`INSERT INTO items (name) VALUES ('a')`),
      ]),
    ).catch((error: unknown) => error);
    expect(classifySqlError(failure).kind).toBe('unique');
    expect(await names()).toEqual([]);
  });

  it('are retried as a whole after the server stole the write lock', async () => {
    const other = rawRemoteClient();
    let otherWrite: Promise<unknown> | undefined;
    let attempts = 0;
    try {
      const result = await runInTransaction(
        handle.db,
        async (tx) => {
          attempts++;
          await insertItem(tx, `attempt ${attempts}`);
          if (attempts === 1) {
            // Another function instance wants to write and waits for our lock.
            otherWrite = other.execute("INSERT INTO items (name) VALUES ('other instance')");
            await sleep(PAST_LOCK_TIMEOUT_MS);
          }
          await insertItem(tx, `attempt ${attempts}, second statement`);
          return attempts;
        },
        { retryDelayMs: 1 },
      );
      await otherWrite;
      expect(result).toBe(2);
      expect(await names()).toEqual(['other instance', 'attempt 2', 'attempt 2, second statement']);
    } finally {
      other.close();
    }
  });

  it('never send (and so never commit) statements after the server rolled the transaction back', async () => {
    const other = rawRemoteClient();
    try {
      const failure = await runInTransaction(
        handle.db,
        async (tx) => {
          await insertItem(tx, 'before the steal');
          const otherWrite = other.execute("INSERT INTO items (name) VALUES ('other instance')");
          await sleep(PAST_LOCK_TIMEOUT_MS);
          // A callback that (wrongly) swallows the failure and carries on.
          const stolen = await insertItem(tx, 'after the steal').catch((error: unknown) => error);
          expect(classifySqlError(stolen).kind).toBe('transaction-timeout');
          await insertItem(tx, 'would run in autocommit').catch(() => undefined);
          await otherWrite;
        },
        { retries: 0 },
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TransactionAbortedError);
      expect(classifySqlError(failure)).toMatchObject({ kind: 'transaction-timeout', retryable: true });
      expect(await names()).toEqual(['other instance']);
    } finally {
      other.close();
    }
  });

  it('documents the hazard: a raw HTTP transaction commits statements sent after a lock steal', async () => {
    // If this starts failing after a @libsql/client upgrade (e.g. Hrana 3's autocommit
    // guard over HTTP), the guard in transaction.ts is still correct, merely redundant.
    const owner = rawRemoteClient();
    const other = rawRemoteClient();
    try {
      const transaction = await owner.transaction('write');
      await transaction.execute("INSERT INTO items (name) VALUES ('raw before the steal')");
      const otherWrite = other.execute("INSERT INTO items (name) VALUES ('other instance')");
      await sleep(PAST_LOCK_TIMEOUT_MS);
      const stolen = await transaction
        .execute("INSERT INTO items (name) VALUES ('raw after the steal')")
        .catch((error: unknown) => error);
      expect(classifySqlError(stolen).kind).toBe('transaction-timeout');
      await transaction.execute("INSERT INTO items (name) VALUES ('raw leaked')");
      await transaction.rollback().catch(() => undefined);
      await otherWrite;
      expect(await names()).toEqual(['other instance', 'raw leaked']);
    } finally {
      owner.close();
      other.close();
    }
  });

  it('are retried as a whole after their stream expired', async () => {
    let attempts = 0;
    await runInTransaction(
      handle.db,
      async (tx) => {
        attempts++;
        await insertItem(tx, `attempt ${attempts}`);
        if (attempts === 1) await sleep(PAST_STREAM_EXPIRY_MS);
        await insertItem(tx, `attempt ${attempts}, second statement`);
      },
      { retryDelayMs: 1 },
    );
    expect(attempts).toBe(2);
    expect(await names()).toEqual(['attempt 2', 'attempt 2, second statement']);
  });
});
