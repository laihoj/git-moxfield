import { LibsqlError } from '@libsql/client/http';
import { createClient as createLocalClient } from '@libsql/client/sqlite3';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import { drizzle as drizzleLocal } from 'drizzle-orm/libsql/sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { deferred } from '@tests/support/async';
import {
  createItemsTables,
  holdWriteLockInChildProcess,
  insertItem,
  itemNames,
  openRawDatabase,
  scratchFileUrl,
} from '@tests/support/libsql';

import type { LibsqlDatabase } from './libsql';
import * as schema from './schema';
import { classifySqlError } from './sql-errors';
import {
  DatabaseMisuseError,
  isTransaction,
  runInTransaction,
  runWrite,
  TransactionAbortedError,
} from './transaction';
import { WriteLockError } from './write-lock';

async function openItems(url: string, options: { busyTimeoutMs?: number } = {}): Promise<LibsqlDatabase> {
  const handle = await openRawDatabase({ url, ...options });
  await createItemsTables(handle.db);
  await handle.db.run(sql`INSERT INTO counter VALUES (1, 0)`);
  return handle;
}

/** Silences the JSON log lines (debug/info go to stdout, warn/error to stderr) and returns them. */
function captureLogs(): () => string[] {
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
  return () => spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));
}

/** `error`, its cause, the cause's cause, ... */
function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = error; current !== undefined && chain.length < 10;) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

/** The first error of `type` in the cause chain of `error`. */
function causeOfType<T>(error: unknown, type: abstract new (...args: never[]) => T): T | undefined {
  return causes(error).find((cause): cause is T => cause instanceof type);
}

/** A transient failure as the remote client reports a lock steal. */
function transactionTimeout(): LibsqlError {
  return new LibsqlError('Transaction timed out', 'TRANSACTION_TIMEOUT');
}

describe.each([
  ['in memory', () => ':memory:'],
  ['in a file', () => scratchFileUrl()],
])('runInTransaction %s', (_, url) => {
  it('commits what the callback did and returns its result', async () => {
    const { db } = await openItems(url());
    const result = await runInTransaction(db, async (tx) => {
      expect(isTransaction(tx)).toBe(true);
      await insertItem(tx, 'a');
      await insertItem(tx, 'b');
      return itemNames(tx);
    });
    expect(result).toEqual(['a', 'b']);
    expect(await itemNames(db)).toEqual(['a', 'b']);
    expect(isTransaction(db)).toBe(false);
  });

  it('rolls back and rethrows the original error object', async () => {
    const { db } = await openItems(url());
    const original = new Error('validation failed');
    await expect(
      runInTransaction(db, async (tx) => {
        await insertItem(tx, 'a');
        throw original;
      }),
    ).rejects.toBe(original);
    expect(await itemNames(db)).toEqual([]);
  });

  it('keeps the original error when the rollback itself fails', async () => {
    const logs = captureLogs();
    const { db } = await openItems(url());
    const original = new Error('the real problem');
    await expect(
      runInTransaction(db, async (tx) => {
        await insertItem(tx, 'a');
        await tx.run(sql`ROLLBACK`); // the following rollback fails: no transaction is active
        throw original;
      }),
    ).rejects.toBe(original);
    expect(await itemNames(db)).toEqual([]);
    expect(logs().some((line) => line.includes('Rolling back a transaction failed'))).toBe(true);
  });

  it('rolls back after tx.rollback() and propagates TransactionRollbackError', async () => {
    const { db } = await openItems(url());
    let attempts = 0;
    await expect(
      runInTransaction(db, async (tx) => {
        attempts++;
        await insertItem(tx, 'a');
        tx.rollback();
      }),
    ).rejects.toBeInstanceOf(TransactionRollbackError);
    expect(attempts).toBe(1);
    expect(await itemNames(db)).toEqual([]);
  });

  it('runs a nested call with the transaction in a savepoint', async () => {
    const { db } = await openItems(url());
    await runInTransaction(db, async (tx) => {
      await insertItem(tx, 'outer');
      await expect(
        runInTransaction(tx, async (inner) => {
          await insertItem(inner, 'inner');
          throw new Error('inner failure');
        }),
      ).rejects.toThrow('inner failure');
      await runInTransaction(tx, (inner) => insertItem(inner, 'second inner'));
    });
    expect(await itemNames(db)).toEqual(['outer', 'second inner']);
  });

  it('rejects root-database use inside the callback', async () => {
    const { db } = await openItems(url());
    const attempts = [
      () => itemNames(db),
      () => insertItem(db, 'outside'),
      () => db.batch([db.run(sql`SELECT 1`)]),
      () => db.$client.execute('SELECT 1'),
    ];
    for (const attempt of attempts) {
      const error = await runInTransaction(db, async (tx) => {
        await insertItem(tx, 'inside');
        await attempt();
      }).catch((caught: unknown) => caught);
      // Drizzle wraps whatever the client throws in a DrizzleQueryError.
      expect(causeOfType(error, DatabaseMisuseError)).toMatchObject({ code: 'root-in-transaction' });
    }
    expect(await itemNames(db)).toEqual([]);
  });

  it('fails fast instead of deadlocking when a write on the root database is nested', async () => {
    const { db } = await openItems(url());
    const nestedTransaction = runInTransaction(db, () => runInTransaction(db, (tx) => insertItem(tx, 'x')));
    await expect(nestedTransaction).rejects.toBeInstanceOf(WriteLockError);
    await expect(nestedTransaction).rejects.toMatchObject({ code: 'reentrant' });
    const nestedWrite = runInTransaction(db, () => runWrite(db, (root) => insertItem(root, 'x')));
    await expect(nestedWrite).rejects.toMatchObject({ code: 'reentrant' });
    const nestedDrizzle = runInTransaction(db, () => db.transaction((tx) => insertItem(tx, 'x')));
    await expect(nestedDrizzle).rejects.toMatchObject({ code: 'root-in-transaction' });
    expect(await itemNames(db)).toEqual([]);
  });

  it('only opens transactions itself', async () => {
    const { db } = await openItems(url());
    await expect(db.transaction((tx) => insertItem(tx, 'a'))).rejects.toMatchObject({
      name: 'DatabaseMisuseError',
      code: 'unmanaged-transaction',
    });
    await expect(db.$client.transaction('write')).rejects.toMatchObject({ code: 'unmanaged-transaction' });
    expect(await itemNames(db)).toEqual([]);
  });

  it('serializes concurrent transactions (read-modify-write never loses an update)', async () => {
    const { db } = await openItems(url());
    await Promise.all(
      Array.from({ length: 20 }, () =>
        runInTransaction(db, async (tx) => {
          const [row] = await tx.all<{ n: number }>(sql`SELECT n FROM counter WHERE id = 1`);
          await new Promise((resolve) => setImmediate(resolve));
          await tx.run(sql`UPDATE counter SET n = ${(row?.n ?? 0) + 1} WHERE id = 1`);
        }),
      ),
    );
    expect(await db.all(sql`SELECT n FROM counter`)).toEqual([{ n: 20 }]);
  });

  it('queues root operations of other requests behind an open transaction', async () => {
    const { db } = await openItems(url());
    const gate = deferred();
    const opened = deferred();
    const transaction = runInTransaction(db, async (tx) => {
      await insertItem(tx, 'a');
      opened.resolve();
      await gate.promise;
    });
    await opened.promise;
    let read: string[] | undefined;
    const reading = itemNames(db).then((result) => (read = result));
    const writing = insertItem(db, 'b');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(read).toBeUndefined();
    gate.resolve();
    await Promise.all([transaction, reading, writing]);
    expect(read).toEqual(['a']);
    expect(await itemNames(db)).toEqual(['a', 'b']);
  });

  it('runs statements issued concurrently inside the callback one at a time, in order', async () => {
    const { db } = await openItems(url());
    const inserted = Array.from({ length: 25 }, (_, i) => `item ${String(i).padStart(2, '0')}`);
    await runInTransaction(db, async (tx) => {
      await Promise.all(inserted.map((name) => insertItem(tx, name)));
    });
    expect(await itemNames(db)).toEqual(inserted);
  });

  it('keeps the transaction usable after a constraint violation the callback handles', async () => {
    const { db } = await openItems(url());
    await runInTransaction(db, async (tx) => {
      await insertItem(tx, 'a');
      const duplicate = await insertItem(tx, 'a').catch((error: unknown) => error);
      expect(classifySqlError(duplicate).kind).toBe('unique');
      await insertItem(tx, 'b');
    });
    expect(await itemNames(db)).toEqual(['a', 'b']);
  });

  it('aborts the transaction after any other failure, even when the callback swallows it', async () => {
    const { db } = await openItems(url());
    const failure = await runInTransaction(
      db,
      async (tx) => {
        await insertItem(tx, 'a');
        const broken = await tx.run(sql`SELEC 1`).catch((error: unknown) => error);
        expect(classifySqlError(broken).kind).toBe('other');
        // Never sent: remotely it could run outside the (possibly rolled back) transaction.
        const after = await insertItem(tx, 'b').catch((error: unknown) => error);
        const aborted = causeOfType(after, TransactionAbortedError);
        expect(aborted).toBeDefined();
        expect(aborted?.cause).toBe(causeOfType(broken, LibsqlError));
      },
      { retries: 0 },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransactionAbortedError);
    expect(await itemNames(db)).toEqual([]);
  });

  it('retries the whole transaction after a retryable failure', async () => {
    const logs = captureLogs();
    const { db } = await openItems(url());
    let attempts = 0;
    const result = await runInTransaction(
      db,
      async (tx) => {
        attempts++;
        await insertItem(tx, `attempt ${attempts}`);
        if (attempts === 1) throw new Error('wrapped', { cause: transactionTimeout() });
        return attempts;
      },
      { retryDelayMs: 1 },
    );
    expect(result).toBe(2);
    expect(await itemNames(db)).toEqual(['attempt 2']);
    const retryLog = logs().find((line) => line.includes('Retrying a database transaction'));
    expect(retryLog).toBeDefined();
    expect(JSON.parse(retryLog ?? '{}')).toMatchObject({
      level: 'warn',
      scope: 'db',
      kind: 'transaction-timeout',
      code: 'TRANSACTION_TIMEOUT',
      retry: 1,
    });
  });

  it('gives up after the configured retries and rethrows the last failure', async () => {
    captureLogs();
    const { db } = await openItems(url());
    let attempts = 0;
    const failures: unknown[] = [];
    const outcome = await runInTransaction(
      db,
      () => {
        attempts++;
        const failure = transactionTimeout();
        failures.push(failure);
        return Promise.reject(failure);
      },
      { retries: 2, retryDelayMs: 0 },
    ).catch((error: unknown) => error);
    expect(attempts).toBe(3);
    expect(outcome).toBe(failures.at(-1));

    attempts = 0;
    await expect(
      runInTransaction(
        db,
        () => {
          attempts++;
          return Promise.reject(transactionTimeout());
        },
        { retries: 0 },
      ),
    ).rejects.toMatchObject({ code: 'TRANSACTION_TIMEOUT' });
    expect(attempts).toBe(1);
  });

  it('does not retry other failures', async () => {
    const { db } = await openItems(url());
    let attempts = 0;
    await runInTransaction(db, (tx) => insertItem(tx, 'a'));
    const failure = await runInTransaction(db, async (tx) => {
      attempts++;
      await insertItem(tx, 'a');
    }).catch((error: unknown) => error);
    expect(classifySqlError(failure).kind).toBe('unique');
    expect(attempts).toBe(1);
  });

  it('gives up waiting for the write lock after lockTimeoutMs', async () => {
    const { db } = await openItems(url());
    const gate = deferred();
    const holder = runInTransaction(db, () => gate.promise);
    let attempts = 0;
    const waiter = runInTransaction(
      db,
      () => {
        attempts++;
        return Promise.resolve();
      },
      { lockTimeoutMs: 20 },
    );
    await expect(waiter).rejects.toBeInstanceOf(WriteLockError);
    await expect(waiter).rejects.toMatchObject({ code: 'timeout' });
    gate.resolve();
    await holder;
    expect(attempts).toBe(0);
  });
});

describe('runInTransaction on a file shared with another process', () => {
  it('takes the write lock up front (BEGIN IMMEDIATE), even before the first write', async () => {
    const url = scratchFileUrl();
    const { db } = await openItems(url, { busyTimeoutMs: 0 });
    const other = createLocalClient({ url });
    try {
      await runInTransaction(db, async (tx) => {
        await itemNames(tx); // reads only
        const blocked = await other
          .execute(`INSERT INTO items (name) VALUES ('other')`)
          .catch((error: unknown) => error);
        expect(classifySqlError(blocked).kind).toBe('busy');
      });
    } finally {
      other.close();
    }
  });

  it('retries while another connection holds the lock', async () => {
    const logs = captureLogs();
    const url = scratchFileUrl();
    // In-process stand-in for another process: SQLite's busy wait would block the holder.
    const { db } = await openItems(url, { busyTimeoutMs: 0 });
    const other = createLocalClient({ url });
    try {
      const blocking = await other.transaction('write');
      await blocking.execute(`INSERT INTO items (name) VALUES ('other process')`);
      setTimeout(() => void blocking.commit(), 50);
      await runInTransaction(db, (tx) => insertItem(tx, 'ours'), { retries: 8, retryDelayMs: 10 });
      expect(await itemNames(db)).toEqual(['other process', 'ours']);
      expect(logs().some((line) => line.includes('"kind":"busy"'))).toBe(true);
    } finally {
      other.close();
    }
  });

  it('reopens its connections after a lock conflict, so later commits are not lost', async () => {
    const logs = captureLogs();
    const url = scratchFileUrl();
    const { db } = await openItems(url, { busyTimeoutMs: 0 });
    const other = createLocalClient({ url });
    try {
      const blocking = await other.transaction('write');
      const busyWrite = await runWrite(db, (root) => insertItem(root, 'blocked'), { retries: 0 }).catch(
        (error: unknown) => error,
      );
      const busyTransaction = await runInTransaction(db, (tx) => insertItem(tx, 'blocked'), {
        retries: 0,
      }).catch((error: unknown) => error);
      expect(classifySqlError(busyWrite).kind).toBe('busy');
      expect(classifySqlError(busyTransaction).kind).toBe('busy');
      await blocking.rollback();

      // libSQL leaves a statement that failed with SQLITE_BUSY active on its connection;
      // without reopening it, this commit would fail ("SQL statements in progress") and the
      // autocommit insert would stay in a transaction that never ends.
      await runInTransaction(db, (tx) => insertItem(tx, 'committed'));
      await insertItem(db, 'autocommitted');
      const seenByOthers = await other.execute('SELECT name FROM items ORDER BY id');
      expect(seenByOthers.rows.map((row) => row.name)).toEqual(['committed', 'autocommitted']);
      expect(logs().some((line) => line.includes('Reopened the local database connections'))).toBe(true);
    } finally {
      other.close();
    }
  });

  it('waits for a lock held by another process instead of failing', async () => {
    const logs = captureLogs();
    const url = scratchFileUrl();
    const { db } = await openItems(url);
    const holder = await holdWriteLockInChildProcess(url, 300);
    try {
      await runInTransaction(db, (tx) => insertItem(tx, 'after the other process'), { retries: 0 });
      expect(await itemNames(db)).toEqual(['from the other process', 'after the other process']);
      expect(logs().some((line) => line.includes('Retrying'))).toBe(false);
    } finally {
      await holder.exited;
    }
  }, 30_000);
});

describe('runWrite', () => {
  it('runs a batch atomically under the write lock', async () => {
    const { db } = await openItems(':memory:');
    await runWrite(db, (root) =>
      root.batch([
        root.run(sql`INSERT INTO items (name) VALUES ('a')`),
        root.run(sql`INSERT INTO items (name) VALUES ('b')`),
      ]),
    );
    expect(await itemNames(db)).toEqual(['a', 'b']);
    const failure = await runWrite(db, (root) =>
      root.batch([
        root.run(sql`INSERT INTO items (name) VALUES ('c')`),
        root.run(sql`INSERT INTO items (name) VALUES ('a')`),
      ]),
    ).catch((error: unknown) => error);
    expect(classifySqlError(failure).kind).toBe('unique');
    expect(await itemNames(db)).toEqual(['a', 'b']);
  });

  it('waits for open transactions and retries transient failures', async () => {
    captureLogs();
    const { db } = await openItems(':memory:');
    const gate = deferred();
    const transaction = runInTransaction(db, async (tx) => {
      await insertItem(tx, 'from the transaction');
      await gate.promise;
    });
    let attempts = 0;
    const write = runWrite(
      db,
      async (root) => {
        attempts++;
        if (attempts === 1) throw transactionTimeout();
        await insertItem(root, 'from the write');
      },
      { retryDelayMs: 1 },
    );
    gate.resolve();
    await Promise.all([transaction, write]);
    expect(attempts).toBe(2);
    expect(await itemNames(db)).toEqual(['from the transaction', 'from the write']);
  });
});

describe('databases not opened with createLibsqlDatabase', () => {
  it('are refused', async () => {
    const client = createLocalClient({ url: ':memory:' });
    try {
      const db = drizzleLocal({ client, schema });
      await expect(runInTransaction(db, () => Promise.resolve())).rejects.toMatchObject({
        name: 'DatabaseMisuseError',
        code: 'unmanaged-database',
      });
      await expect(runWrite(db, () => Promise.resolve())).rejects.toMatchObject({
        code: 'unmanaged-database',
      });
    } finally {
      client.close();
    }
  });

  it('would lose the original error when the rollback fails (why the guard exists)', async () => {
    const client = createLocalClient({ url: ':memory:' });
    try {
      const db = drizzleLocal({ client, schema });
      const original = new Error('the real problem');
      const outcome = await db
        .transaction(async (tx) => {
          await tx.run(sql`ROLLBACK`);
          throw original;
        })
        .catch((error: unknown) => error);
      expect(outcome).not.toBe(original);
      expect(classifySqlError(outcome).code).toBe('TRANSACTION_CLOSED');
    } finally {
      client.close();
    }
  });
});
