/**
 * Classification of the errors a remote libSQL server really returns (no extended codes;
 * the kind is in the message, with a doubled prefix inside transactions and batches), and
 * the server's 5,000,000-byte length limit (per value and per stored row).
 */
import { LibsqlBatchError } from '@libsql/client/http';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LibsqlDatabase, LibsqlExecutor } from '@/server/db/libsql';
import { applyMigrations } from '@/server/db/migration-state';
import * as schema from '@/server/db/schema';
import { classifySqlError, type SqlErrorKind } from '@/server/db/sql-errors';
import { runInTransaction, runWrite } from '@/server/db/transaction';
import { seedDeckHistory, type SeededHistory } from '@tests/support/libsql';

import { openRemote, wipeRemoteDatabase } from './support';

const AT = '2026-01-01T00:00:00.000Z';

let handle: LibsqlDatabase;
let seeded: SeededHistory;

beforeAll(async () => {
  await wipeRemoteDatabase();
  handle = await openRemote();
  await applyMigrations(handle.db);
  seeded = await seedDeckHistory(handle.db, 'errors-deck');
  await handle.db.run(sql`CREATE TABLE checked (n INTEGER CHECK (n > 0))`);
});

afterAll(() => {
  handle.close();
});

async function failure(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to fail');
}

/** Each case: kind, message, and the failing statement (on the root db or a transaction). */
function cases(): [SqlErrorKind, string, (db: LibsqlExecutor) => Promise<unknown>][] {
  const deck = {
    id: 'another-deck',
    workspaceId: seeded.workspaceId,
    source: 'moxfield',
    externalId: 'another-deck',
    url: 'https://moxfield.com/decks/another-deck',
    name: 'Another deck',
    createdAt: AT,
    updatedAt: AT,
  };
  return [
    [
      'foreign-key',
      'FOREIGN KEY constraint failed',
      (db) => db.insert(schema.decks).values({ ...deck, workspaceId: 'nope' }),
    ],
    [
      'unique',
      'UNIQUE constraint failed: decks.workspace_id, decks.source, decks.external_id',
      (db) => db.insert(schema.decks).values({ ...deck, externalId: seeded.deckId }),
    ],
    // A PRIMARY KEY violation: no extended code remotely, the same text as UNIQUE.
    [
      'unique',
      'UNIQUE constraint failed: decks.id',
      (db) => db.insert(schema.decks).values({ ...deck, id: seeded.deckId }),
    ],
    [
      'not-null',
      'NOT NULL constraint failed: workspaces.name',
      (db) => db.run(sql`INSERT INTO workspaces (id, name, created_at) VALUES ('w-null', NULL, ${AT})`),
    ],
    ['check', 'CHECK constraint failed: n > 0', (db) => db.run(sql`INSERT INTO checked VALUES (0)`)],
    [
      'trigger',
      'commits are immutable',
      (db) =>
        db.update(schema.commits).set({ message: 'rewritten' }).where(eq(schema.commits.id, seeded.commitId)),
    ],
  ];
}

describe('remote errors', () => {
  it('are classified by their message in autocommit mode', async () => {
    for (const [kind, message, operation] of cases()) {
      const error = await failure(() => operation(handle.db));
      expect(classifySqlError(error), message).toEqual({
        kind,
        message,
        retryable: false,
        code: 'SQLITE_CONSTRAINT',
      });
    }
  });

  it('are classified the same inside a transaction, which they leave usable', async () => {
    await runInTransaction(handle.db, async (tx) => {
      for (const [kind, message, operation] of cases()) {
        const error = await failure(() => operation(tx));
        expect(String((error as Error).cause)).toMatch(/SQLITE_CONSTRAINT: SQLITE_CONSTRAINT: SQLite error:/);
        expect(classifySqlError(error), message).toMatchObject({ kind, message });
      }
      await tx.run(sql`INSERT INTO checked VALUES (1)`);
    });
    expect(await handle.db.all(sql`SELECT n FROM checked`)).toEqual([{ n: 1 }]);
  });

  it('are classified the same in a batch, which leaves nothing behind', async () => {
    const { db } = handle;
    const error = await failure(() =>
      runWrite(db, (root) =>
        root.batch([
          root.run(sql`INSERT INTO checked VALUES (2)`),
          root.run(sql`INSERT INTO checked VALUES (-2)`),
        ]),
      ),
    );
    expect(error).toBeInstanceOf(LibsqlBatchError);
    expect(classifySqlError(error)).toMatchObject({
      kind: 'check',
      message: 'CHECK constraint failed: n > 0',
    });
    expect(await db.all(sql`SELECT n FROM checked WHERE n = 2`)).toEqual([]);
  });

  it('include SQL the server cannot parse', async () => {
    const error = await failure(() => handle.db.run(sql.raw('SELEC 1')));
    expect(classifySqlError(error)).toMatchObject({
      kind: 'other',
      code: 'SQL_PARSE_ERROR',
      retryable: false,
    });
  });
});

describe('the 5,000,000-byte length limit', () => {
  function rawBlob(hash: string, size: number): Promise<unknown> {
    return handle.db.insert(schema.rawBlobs).values({
      hash,
      mediaType: 'application/octet-stream',
      encoding: 'gzip',
      byteLength: size,
      data: Buffer.alloc(size, 1),
      createdAt: AT,
    });
  }

  it('applies to whole stored rows, not only to bound arguments', async () => {
    await rawBlob('blob-below-limit', 4_900_000);
    // The value alone is within the limit, but the row (value plus other columns) is not.
    const rowTooBig = await failure(() => rawBlob('blob-at-limit', 5_000_000));
    expect(classifySqlError(rowTooBig)).toEqual({
      kind: 'too-big',
      message: 'string or blob too big',
      retryable: false,
      code: 'SQLITE_TOOBIG',
    });
    // One byte more is rejected before the statement runs.
    const argumentTooBig = await failure(() => rawBlob('blob-over-limit', 5_000_001));
    expect(classifySqlError(argumentTooBig)).toEqual({
      kind: 'too-big',
      message: 'Arguments do not match SQL parameters: string or blob too big',
      retryable: false,
      code: 'ARGS_INVALID',
    });
    const stored = await handle.db.select({ hash: schema.rawBlobs.hash }).from(schema.rawBlobs);
    expect(stored.map((row) => row.hash)).toEqual(['blob-below-limit']);
  });
});
