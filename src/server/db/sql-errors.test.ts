import { LibsqlBatchError, LibsqlError } from '@libsql/client/http';
import { createClient as createLocalClient } from '@libsql/client/sqlite3';
import { DrizzleQueryError, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { seedDeckHistory, tempFileUrl } from '@tests/support/libsql';

import { createLibsqlDatabase, type LibsqlDatabase } from './libsql';
import { applyMigrations } from './migration-state';
import * as schema from './schema';
import {
  classifySqlError,
  isConstraintViolation,
  isRetryableSqlError,
  isSqlErrorKind,
  type SqlErrorKind,
} from './sql-errors';
import { TransactionAbortedError } from './transaction';

/** The native error under a local `LibsqlError`: a `SqliteError` whose `code` is the extended code. */
function nativeSqliteError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'SqliteError', code });
}

/** What the remote (HTTP) client throws: a `LibsqlError` with a code and message only. */
function remoteError(code: string, message: string): LibsqlError {
  return new LibsqlError(message, code);
}

/** What a statement inside a remote transaction or batch throws (doubled code prefix). */
function remoteBatchError(code: string, message: string): LibsqlBatchError {
  return new LibsqlBatchError(`${code}: ${message}`, 0, code);
}

/** What a local (native) client throws: code, extended code and raw code. */
function localError(extendedCode: string, rawCode: number, message: string): LibsqlError {
  return new LibsqlError(message, extendedCode.replace(/^(SQLITE_[A-Z]+).*$/, '$1'), extendedCode, rawCode);
}

describe('classifySqlError', () => {
  describe('local libSQL errors (extended codes)', () => {
    it.each<[string, number, string, SqlErrorKind]>([
      ['SQLITE_CONSTRAINT_FOREIGNKEY', 787, 'FOREIGN KEY constraint failed', 'foreign-key'],
      ['SQLITE_CONSTRAINT_UNIQUE', 2067, 'UNIQUE constraint failed: decks.name', 'unique'],
      ['SQLITE_CONSTRAINT_PRIMARYKEY', 1555, 'UNIQUE constraint failed: decks.id', 'unique'],
      ['SQLITE_CONSTRAINT_NOTNULL', 1299, 'NOT NULL constraint failed: decks.name', 'not-null'],
      ['SQLITE_CONSTRAINT_CHECK', 275, 'CHECK constraint failed: n > 0', 'check'],
      ['SQLITE_CONSTRAINT_TRIGGER', 1811, 'commits are immutable', 'trigger'],
      ['SQLITE_BUSY', 5, 'database is locked', 'busy'],
      ['SQLITE_TOOBIG', 18, 'string or blob too big', 'too-big'],
    ])('%s is %s', (extendedCode, rawCode, message, kind) => {
      const classification = classifySqlError(localError(extendedCode, rawCode, message));
      expect(classification).toEqual({
        kind,
        message,
        retryable: kind === 'busy',
        code: extendedCode,
      });
    });

    it('reads the extended code through a DrizzleQueryError and never exposes its parameters', () => {
      const driver = localError('SQLITE_CONSTRAINT_FOREIGNKEY', 787, 'FOREIGN KEY constraint failed');
      const error = new DrizzleQueryError('insert into "sessions" values (?)', ['secret-token-hash'], driver);
      const classification = classifySqlError(error);
      expect(classification.kind).toBe('foreign-key');
      expect(classification.message).toBe('FOREIGN KEY constraint failed');
      expect(JSON.stringify(classification)).not.toContain('secret-token-hash');
    });

    it('does not leak the parameters of a DrizzleQueryError without a driver error either', () => {
      const error = new DrizzleQueryError('select ?', ['secret-token-hash']);
      expect(classifySqlError(error)).toEqual({
        kind: 'other',
        message: 'Database query failed',
        retryable: false,
        code: undefined,
      });
    });

    it('falls back to the raw code', () => {
      expect(classifySqlError({ rawCode: 787, message: 'FOREIGN KEY constraint failed' }).kind).toBe(
        'foreign-key',
      );
      // SQLITE_BUSY_SNAPSHOT (517) and SQLITE_LOCKED (6): busy by their primary code.
      expect(classifySqlError({ rawCode: 517, message: 'database is locked' })).toMatchObject({
        kind: 'busy',
        retryable: true,
      });
      expect(classifySqlError({ rawCode: 6, message: 'database table is locked' }).kind).toBe('busy');
    });

    it('reports other SQLite errors as other, with their code', () => {
      expect(classifySqlError(localError('SQLITE_ERROR', 1, 'no such table: nope'))).toEqual({
        kind: 'other',
        message: 'no such table: nope',
        retryable: false,
        code: 'SQLITE_ERROR',
      });
    });
  });

  describe('remote libSQL errors (code and message only)', () => {
    it.each<[string, SqlErrorKind]>([
      ['FOREIGN KEY constraint failed', 'foreign-key'],
      ['UNIQUE constraint failed: decks.workspace_id, decks.source, decks.external_id', 'unique'],
      // A PRIMARY KEY violation reads exactly like a UNIQUE one remotely.
      ['UNIQUE constraint failed: decks.id', 'unique'],
      ['NOT NULL constraint failed: decks.name', 'not-null'],
      ['CHECK constraint failed: n > 0', 'check'],
      ['commits are immutable', 'trigger'],
      ['commits are immutable; delete the deck to remove its history', 'trigger'],
      ['raw blobs are immutable', 'trigger'],
      ['cannot store TEXT value in INTEGER column t.n', 'other'],
    ])('SQLITE_CONSTRAINT "%s" is %s', (message, kind) => {
      for (const error of [
        remoteError('SQLITE_CONSTRAINT', `SQLite error: ${message}`),
        remoteBatchError('SQLITE_CONSTRAINT', `SQLite error: ${message}`),
      ]) {
        expect(classifySqlError(error)).toEqual({
          kind,
          message,
          retryable: false,
          code: 'SQLITE_CONSTRAINT',
        });
        expect(classifySqlError(new DrizzleQueryError('update "commits" set ...', [], error)).kind).toBe(
          kind,
        );
      }
    });

    it('strips the doubled prefix of statements in transactions and batches', () => {
      const error = remoteBatchError('SQLITE_CONSTRAINT', 'SQLite error: commits are immutable');
      expect(error.message).toBe('SQLITE_CONSTRAINT: SQLITE_CONSTRAINT: SQLite error: commits are immutable');
      expect(classifySqlError(error).message).toBe('commits are immutable');
    });

    it.each<[string, string, SqlErrorKind, boolean]>([
      ['TRANSACTION_TIMEOUT', 'Transaction timed out', 'transaction-timeout', true],
      ['STREAM_EXPIRED', 'The stream has expired due to inactivity', 'stream-expired', true],
      ['BLOCKED', 'Operation was blocked', 'quota-blocked', false],
      ['ARGS_INVALID', 'Arguments do not match SQL parameters: string or blob too big', 'too-big', false],
      ['SQLITE_TOOBIG', 'SQLite error: string or blob too big', 'too-big', false],
      ['ARGS_INVALID', 'Arguments do not match SQL parameters: missing argument', 'other', false],
      ['SQLITE_UNKNOWN', 'SQLite error: cannot commit - no transaction is active', 'other', false],
      ['SQLITE_UNKNOWN', 'SQLite error: database is locked', 'busy', true],
      ['SQLITE_BUSY', 'SQLite error: database is locked', 'busy', true],
      [
        'SQL_PARSE_ERROR',
        'SQL string could not be parsed: unsupported statement: PRAGMA busy_timeout = 1',
        'other',
        false,
      ],
      ['TRANSACTION_CLOSED', 'Cannot commit the transaction because it is already closed', 'other', false],
    ])('%s "%s" is %s', (code, message, kind, retryable) => {
      for (const error of [remoteError(code, message), remoteBatchError(code, message)]) {
        expect(classifySqlError(error)).toEqual({
          kind,
          message: message.replace(/^SQLite error: /, ''),
          retryable,
          code,
        });
      }
    });

    it('prefers the plain message of the innermost driver error', () => {
      // The HTTP client's LibsqlError wraps hrana's ResponseError (same code, plain message).
      const response = Object.assign(new Error('SQLite error: FOREIGN KEY constraint failed'), {
        name: 'ResponseError',
        code: 'SQLITE_CONSTRAINT',
      });
      const error = new LibsqlBatchError(
        'SQLITE_CONSTRAINT: SQLite error: FOREIGN KEY constraint failed',
        2,
        'SQLITE_CONSTRAINT',
        undefined,
        undefined,
        response,
      );
      expect(classifySqlError(error)).toMatchObject({
        kind: 'foreign-key',
        message: 'FOREIGN KEY constraint failed',
      });
    });
  });

  describe('native SQLite errors (the cause of a local LibsqlError)', () => {
    it.each<[string, string, SqlErrorKind]>([
      ['SQLITE_CONSTRAINT_FOREIGNKEY', 'FOREIGN KEY constraint failed', 'foreign-key'],
      ['SQLITE_CONSTRAINT_PRIMARYKEY', 'UNIQUE constraint failed: p.id', 'unique'],
      ['SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE constraint failed: p.name', 'unique'],
      ['SQLITE_CONSTRAINT_NOTNULL', 'NOT NULL constraint failed: p.name', 'not-null'],
      ['SQLITE_CONSTRAINT_TRIGGER', 'commits are immutable', 'trigger'],
      ['SQLITE_BUSY', 'database is locked', 'busy'],
    ])('%s is %s', (code, message, kind) => {
      expect(classifySqlError(nativeSqliteError(code, message))).toEqual({
        kind,
        message,
        retryable: kind === 'busy',
        code,
      });
    });
  });

  describe('cause chains and non-database errors', () => {
    it('finds the database error under application errors', () => {
      const driver = remoteBatchError('TRANSACTION_TIMEOUT', 'Transaction timed out');
      const aborted = new TransactionAbortedError(driver);
      const wrapped = Object.assign(new Error('Could not save the version', { cause: aborted }), {
        code: 'conflict',
      });
      expect(classifySqlError(wrapped)).toEqual({
        kind: 'transaction-timeout',
        message: 'Transaction timed out',
        retryable: true,
        code: 'TRANSACTION_TIMEOUT',
      });
    });

    it('reports errors without a database cause as other, with their own message', () => {
      const appError = Object.assign(new Error('Deck not found'), { code: 'not-found' });
      expect(classifySqlError(appError)).toEqual({
        kind: 'other',
        message: 'Deck not found',
        retryable: false,
        code: undefined,
      });
      expect(classifySqlError(new TypeError('fetch failed'))).toMatchObject({
        kind: 'other',
        message: 'fetch failed',
      });
    });

    it.each([undefined, null, 42, 'text', {}, [], Symbol('x')])('never throws for %s', (value) => {
      expect(classifySqlError(value)).toMatchObject({ kind: 'other', retryable: false, code: undefined });
    });

    it('never throws for objects whose properties throw', () => {
      const hostile = new Proxy(
        {},
        {
          get() {
            throw new Error('no reading');
          },
        },
      );
      expect(classifySqlError(hostile)).toMatchObject({ kind: 'other', retryable: false });
      expect(classifySqlError(new Error('outer', { cause: hostile })).message).toBe('outer');
    });

    it('stops at cycles and very deep chains', () => {
      const a = new Error('a');
      const b = new Error('b', { cause: a });
      Object.assign(a, { cause: b });
      expect(classifySqlError(a).kind).toBe('other');

      let deep: unknown = remoteError('SQLITE_CONSTRAINT', 'SQLite error: FOREIGN KEY constraint failed');
      for (let i = 0; i < 100; i++) deep = new Error(`layer ${i}`, { cause: deep });
      expect(classifySqlError(deep).kind).toBe('other');
    });
  });

  it('has helpers for the common questions', () => {
    const fk = localError('SQLITE_CONSTRAINT_FOREIGNKEY', 787, 'FOREIGN KEY constraint failed');
    expect(isSqlErrorKind(fk, 'foreign-key')).toBe(true);
    expect(isSqlErrorKind(fk, 'unique')).toBe(false);
    expect(isRetryableSqlError(fk)).toBe(false);
    expect(isRetryableSqlError(remoteError('STREAM_EXPIRED', 'The stream has expired'))).toBe(true);
    expect(
      ['foreign-key', 'unique', 'not-null', 'check', 'trigger'].every((kind) =>
        isConstraintViolation(kind as SqlErrorKind),
      ),
    ).toBe(true);
    expect(
      ['busy', 'transaction-timeout', 'stream-expired', 'quota-blocked', 'too-big', 'other'].some((kind) =>
        isConstraintViolation(kind as SqlErrorKind),
      ),
    ).toBe(false);
  });
});

describe('classifySqlError with real local libSQL errors', () => {
  let database: LibsqlDatabase;

  beforeEach(async () => {
    database = await createLibsqlDatabase({ url: ':memory:' });
    await applyMigrations(database.db);
  });

  afterEach(() => {
    database.close();
  });

  async function failure(operation: () => Promise<unknown>): Promise<unknown> {
    try {
      await operation();
    } catch (error) {
      return error;
    }
    throw new Error('expected the operation to fail');
  }

  it('classifies constraint violations of the app schema', async () => {
    const { db } = database;
    const seeded = await seedDeckHistory(db);
    const at = '2026-01-01T00:00:00.000Z';
    const deck = {
      id: 'deck-2',
      workspaceId: seeded.workspaceId,
      source: 'moxfield',
      externalId: 'deck-2',
      url: 'https://moxfield.com/decks/deck-2',
      name: 'Deck 2',
      createdAt: at,
      updatedAt: at,
    };

    const cases: [SqlErrorKind, string, () => Promise<unknown>][] = [
      [
        'foreign-key',
        'FOREIGN KEY constraint failed',
        () => db.insert(schema.decks).values({ ...deck, workspaceId: 'nope' }),
      ],
      [
        'unique',
        'UNIQUE constraint failed: decks.workspace_id, decks.source, decks.external_id',
        () => db.insert(schema.decks).values({ ...deck, id: 'deck-3', externalId: seeded.deckId }),
      ],
      [
        'unique',
        'UNIQUE constraint failed: decks.id',
        () => db.insert(schema.decks).values({ ...deck, id: seeded.deckId }),
      ],
      [
        'not-null',
        'NOT NULL constraint failed: workspaces.name',
        () => db.run(sql`INSERT INTO workspaces (id, name, created_at) VALUES ('w2', NULL, ${at})`),
      ],
      [
        'trigger',
        'commits are immutable',
        () =>
          db
            .update(schema.commits)
            .set({ message: 'rewritten' })
            .where(eq(schema.commits.id, seeded.commitId)),
      ],
      [
        'trigger',
        'commits are immutable; delete the deck to remove its history',
        () => db.delete(schema.commits).where(eq(schema.commits.id, seeded.commitId)),
      ],
      [
        'trigger',
        'snapshots are immutable',
        () =>
          db
            .update(schema.snapshots)
            .set({ canonicalJson: '[]' })
            .where(eq(schema.snapshots.hash, seeded.snapshotHash)),
      ],
    ];
    for (const [kind, message, operation] of cases) {
      const error = await failure(operation);
      expect(error).toBeInstanceOf(DrizzleQueryError);
      expect(classifySqlError(error), message).toMatchObject({ kind, message, retryable: false });
    }
  });

  it('classifies a CHECK constraint and a failing batch', async () => {
    const { db } = database;
    await db.run(sql`CREATE TABLE checked (n INTEGER CHECK (n > 0))`);
    expect(classifySqlError(await failure(() => db.run(sql`INSERT INTO checked VALUES (0)`)))).toMatchObject({
      kind: 'check',
      message: 'CHECK constraint failed: n > 0',
    });

    const batchError = await failure(() =>
      db.batch([db.run(sql`INSERT INTO checked VALUES (1)`), db.run(sql`INSERT INTO checked VALUES (-1)`)]),
    );
    expect(batchError).toBeInstanceOf(LibsqlBatchError);
    expect(classifySqlError(batchError)).toMatchObject({ kind: 'check', code: 'SQLITE_CONSTRAINT_CHECK' });
  });

  it('classifies a lock held by another connection as busy and retryable', async () => {
    const url = tempFileUrl();
    // No busy wait: the lock holder below runs in this process and could never release it.
    const handle = await createLibsqlDatabase({ url, busyTimeoutMs: 0 });
    // A second client on the same file, as another process would have.
    const other = createLocalClient({ url });
    try {
      await handle.db.run(sql`CREATE TABLE t (n INTEGER)`);
      const blocking = await other.transaction('write');
      const error = await failure(() => handle.db.run(sql`INSERT INTO t VALUES (1)`));
      await blocking.rollback();
      expect(classifySqlError(error)).toEqual({
        kind: 'busy',
        message: 'database is locked',
        retryable: true,
        code: 'SQLITE_BUSY',
      });
    } finally {
      other.close();
      handle.close();
    }
  });
});
