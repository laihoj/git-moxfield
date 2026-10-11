/**
 * Opens libSQL databases: Turso (or any libSQL server) over HTTP in production, local
 * files and in-memory databases in development and tests. One driver and one SQL dialect
 * everywhere (ADR 0008).
 *
 * - Remote URLs (`libsql:`, `https:`, `http:`, and `wss:`/`ws:`, which are served over
 *   HTTP on the same host and port) use `@libsql/client/http`: pure JavaScript, so the
 *   serverless bundle never loads a native module. The root `@libsql/client` entry would
 *   load the platform binary at import time even for remote URLs.
 * - Local URLs (`file:...`, `:memory:`) use `@libsql/client/sqlite3`, the native client,
 *   imported lazily so that only processes that open a local database load it.
 * - Both are wrapped in Drizzle by `drizzle-orm/libsql/http` with an explicit client (its
 *   `drizzle()` only differs from the other entries in the client it would create itself),
 *   so remote and local databases have exactly the same type, {@link LibsqlDb}.
 *
 * Every database is checked when opened: foreign keys must be enforced (libSQL enables
 * them by default; the app relies on them for referential integrity and `ON DELETE
 * CASCADE`). Local files are switched to write-ahead logging, which survives in the file:
 * readers never block the writer and vice versa, as on the server (Turso runs in WAL
 * mode). Per-connection `PRAGMA`s are deliberately not used: a local client keeps a pool of
 * connections opened on demand, so a `PRAGMA` would only reach one of them, and remote
 * servers reject `busy_timeout`/`journal_mode` (`SQL_PARSE_ERROR`).
 *
 * Local files get a busy timeout (the client's `timeout` option, applied to every pooled
 * connection). SQLite's busy wait blocks the event loop, which is harmless here: every
 * operation of this process on a local database runs under the write lock (see
 * `transaction.ts`), so the lock can only be held by *another process* (a script next to
 * the dev server), which does finish. Without it, libSQL fails at once with `SQLITE_BUSY`.
 */
import 'server-only';

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  createClient as createHttpClient,
  type Client,
  type ResultSet,
  type Value,
} from '@libsql/client/http';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql/driver-core';
import { drizzle } from 'drizzle-orm/libsql/http';
import type { BaseSQLiteDatabase, SQLiteTransaction } from 'drizzle-orm/sqlite-core';

import {
  databaseUrlScheme,
  isRemoteDatabaseScheme,
  MEMORY_DATABASE_URL,
  SUPPORTED_DATABASE_URLS_HINT,
} from './database-location';
import * as schema from './schema';
import { guardClient } from './transaction';
import { sharedWriteLock, WriteLock } from './write-lock';

export type Schema = typeof schema;

/** The root database. Repositories should accept {@link LibsqlExecutor} instead. */
export type LibsqlDb = LibSQLDatabase<Schema> & { $client: Client };

/** A transaction, as passed to a `runInTransaction` callback. */
export type LibsqlTx = SQLiteTransaction<'async', ResultSet, Schema, ExtractTablesWithRelations<Schema>>;

/** Anything that runs queries: the root database or a transaction. */
export type LibsqlExecutor = BaseSQLiteDatabase<'async', ResultSet, Schema>;

export type DatabaseKind = 'remote' | 'local';

/** Default wait limit for the in-process write lock. */
export const DEFAULT_LOCK_TIMEOUT_MS = 15_000;

/** Default time a local file database waits for another process's lock. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface LibsqlDatabaseOptions {
  /**
   * `libsql://<db>-<org>.turso.io`, `https://...`, `http://127.0.0.1:8080` (local
   * libSQL server), `ws(s)://...`; `file:relative/path.db`, `file:/absolute/path.db`;
   * `:memory:` for a private in-memory database.
   */
  url: string;
  /** Auth token for remote databases (Turso). Ignored for local ones. */
  authToken?: string;
  /** How long a writer (or, locally, any operation) waits for the write lock. Default 15 s. */
  lockTimeoutMs?: number;
  /**
   * Local files only: how long SQLite waits (blocking) for another process to release the
   * database lock before failing with `SQLITE_BUSY`. Default 5 s; 0 fails at once.
   */
  busyTimeoutMs?: number;
}

export interface LibsqlDatabase {
  readonly db: LibsqlDb;
  /** The guarded client behind `db` (`db.$client`). */
  readonly client: Client;
  readonly kind: DatabaseKind;
  /** The in-process write lock shared by every handle on this database. */
  readonly writeLock: WriteLock;
  /** Closes the connection(s). Idempotent. Operations still in flight fail. */
  close(): void;
}

/** The database URL or the database itself is unusable. */
export class DatabaseConfigError extends Error {
  override readonly name = 'DatabaseConfigError';
}

interface RemoteTarget {
  readonly kind: 'remote';
  /** The URL as the HTTP client accepts it (`ws:`/`wss:` mapped to `http:`/`https:`). */
  readonly clientUrl: string;
  readonly lockKey: string;
  readonly description: string;
}

interface LocalTarget {
  readonly kind: 'local';
  readonly clientUrl: string;
  /** Absolute path of a file database; `undefined` in memory. */
  readonly file: string | undefined;
  /** `undefined` for a private in-memory database, which gets a lock of its own. */
  readonly lockKey: string | undefined;
  readonly description: string;
}

type DatabaseTarget = RemoteTarget | LocalTarget;

function parseRemote(clientUrl: string): RemoteTarget {
  let parsed: URL;
  try {
    parsed = new URL(clientUrl);
  } catch {
    throw new DatabaseConfigError('The database URL is not a valid URL.');
  }
  if (parsed.host === '') throw new DatabaseConfigError('The remote database URL has no host.');
  // Scheme-independent and without credentials or query (an authToken may be in it).
  const location = `${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  return {
    kind: 'remote',
    clientUrl,
    lockKey: `remote:${location}`,
    description: `remote database ${location}`,
  };
}

function parseFile(url: string): LocalTarget {
  const rest = url.slice('file:'.length);
  if (rest === ':memory:' || rest.startsWith(':memory:?')) {
    const shared = /[?&]cache=shared(&|$)/.test(rest);
    return {
      kind: 'local',
      clientUrl: url,
      file: undefined,
      lockKey: shared ? 'memory:shared' : undefined,
      description: shared ? 'shared in-memory database' : 'in-memory database',
    };
  }
  // `file:path`, `file:/abs/path`, `file:///abs/path`, `file://localhost/abs/path`.
  let path = rest.startsWith('//') ? rest.slice(Math.max(2, rest.indexOf('/', 2))) : rest;
  const query = path.indexOf('?');
  if (query !== -1) path = path.slice(0, query);
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep it as written; the client reports an invalid URL
  }
  if (path === '') throw new DatabaseConfigError('The file database URL has no path.');
  const file = resolve(path);
  return {
    kind: 'local',
    clientUrl: url,
    file,
    lockKey: `file:${file}`,
    description: `database file ${file}`,
  };
}

function parseDatabaseUrl(url: string): DatabaseTarget {
  const trimmed = url.trim();
  if (trimmed === MEMORY_DATABASE_URL) {
    return {
      kind: 'local',
      clientUrl: trimmed,
      file: undefined,
      lockKey: undefined,
      description: 'in-memory database',
    };
  }
  const scheme = databaseUrlScheme(trimmed);
  if (scheme === 'file') return parseFile(trimmed);
  if (isRemoteDatabaseScheme(scheme)) {
    return parseRemote(trimmed.replace(/^ws(s?):/i, (_, secure: string) => `http${secure}:`));
  }
  // Never echo the URL: it may carry credentials.
  throw new DatabaseConfigError(
    `Unsupported database URL${scheme === undefined ? '' : ` scheme "${scheme}:"`}. Use ${SUPPORTED_DATABASE_URLS_HINT}.`,
  );
}

/** Whether `url` names a remote or a local database. @throws {DatabaseConfigError} for other URLs. */
export function databaseKindOf(url: string): DatabaseKind {
  return parseDatabaseUrl(url).kind;
}

/** A description of the database `url` names that is safe to log (no credentials, no query). */
export function describeDatabaseUrl(url: string): string {
  return parseDatabaseUrl(url).description;
}

/**
 * The absolute path of the database file `url` names; `undefined` for in-memory and
 * remote databases. @throws {DatabaseConfigError} for other URLs.
 */
export function databaseFileOf(url: string): string | undefined {
  const target = parseDatabaseUrl(url);
  return target.kind === 'local' ? target.file : undefined;
}

function text(value: Value | undefined): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  return '';
}

async function openLocalClient(target: LocalTarget, busyTimeoutMs: number): Promise<Client> {
  if (target.file !== undefined) mkdirSync(dirname(target.file), { recursive: true });
  // Lazy: loads the native libSQL binding, which only local databases need.
  const { createClient } = await import('@libsql/client/sqlite3');
  return createClient({
    url: target.clientUrl,
    ...(target.file === undefined ? {} : { timeout: Math.max(0, busyTimeoutMs) }),
  });
}

async function enableWriteAheadLog(client: Client, target: LocalTarget): Promise<void> {
  const result = await client.execute('PRAGMA journal_mode = WAL');
  const mode = text(result.rows[0]?.[0]).toLowerCase();
  if (mode !== 'wal') {
    throw new DatabaseConfigError(
      `Could not switch the ${target.description} to write-ahead logging (journal mode: ` +
        `"${mode}"). Its file system may not support it (network drives do not).`,
    );
  }
}

async function assertForeignKeysEnforced(client: Client, target: DatabaseTarget): Promise<void> {
  const result = await client.execute('PRAGMA foreign_keys');
  if (Number(result.rows[0]?.[0]) === 1) return;
  throw new DatabaseConfigError(
    target.kind === 'remote'
      ? `The ${target.description} does not enforce foreign keys. git-moxfield relies on them ` +
          "(referential integrity, ON DELETE CASCADE). Turso's libSQL databases enforce them by " +
          'default; a database created with --tursodb (a different engine) may not.'
      : `The local libSQL build does not enforce foreign keys by default (${target.description}). ` +
          'git-moxfield relies on them, and a PRAGMA cannot reach every pooled connection; ' +
          'use a libSQL build compiled with SQLITE_DEFAULT_FOREIGN_KEYS=1 (the official one is).',
  );
}

/**
 * Opens the database `options.url` names, verifies it (foreign keys enforced; local files
 * in WAL mode) and wraps it for {@link runInTransaction}/{@link runWrite}. Applies no
 * migrations (see `migration-state.ts`).
 *
 * @throws {DatabaseConfigError} for an unsupported URL or a database that fails the
 *   checks; the driver's error when the database cannot be reached or opened.
 */
export async function createLibsqlDatabase(options: LibsqlDatabaseOptions): Promise<LibsqlDatabase> {
  const target = parseDatabaseUrl(options.url);
  const raw =
    target.kind === 'remote'
      ? createHttpClient({ url: target.clientUrl, authToken: options.authToken })
      : await openLocalClient(target, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
  const writeLock =
    target.lockKey === undefined ? new WriteLock(target.description) : sharedWriteLock(target.lockKey);
  const client = guardClient(raw, {
    lock: writeLock,
    lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    serializeRootOperations: target.kind === 'local',
    recycleAfterBusy: target.kind === 'local' && target.file !== undefined,
  });
  try {
    if (target.kind === 'local' && target.file !== undefined) await enableWriteAheadLog(client, target);
    await assertForeignKeysEnforced(client, target);
  } catch (error) {
    client.close();
    throw error;
  }
  const db: LibsqlDb = drizzle({ client, schema });
  return {
    db,
    client,
    kind: target.kind,
    writeLock,
    close: () => {
      if (!client.closed) client.close();
    },
  };
}
