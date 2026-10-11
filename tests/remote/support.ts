/**
 * Helpers for the remote libSQL suite (see `vitest.remote.config.ts`).
 */
import { createClient as createHttpClient, type Client } from '@libsql/client/http';
import { drizzle } from 'drizzle-orm/libsql/http';

import { ensureLocalWorkspace } from '@/server/db/client';
import {
  createLibsqlDatabase,
  DEFAULT_LOCK_TIMEOUT_MS,
  type LibsqlDatabase,
  type LibsqlDb,
} from '@/server/db/libsql';
import { applyMigrations } from '@/server/db/migration-state';
import * as schema from '@/server/db/schema';
import { guardClient } from '@/server/db/transaction';
import { WriteLock } from '@/server/db/write-lock';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface RemoteTarget {
  readonly url: string;
  readonly authToken: string | undefined;
}

/**
 * The server under test, from `LIBSQL_TEST_URL` (and `LIBSQL_TEST_AUTH_TOKEN`).
 *
 * @throws when the variable is missing, or names a non-local server without
 *   `LIBSQL_TEST_ALLOW_WIPE=1` (the suite wipes the database).
 */
export function remoteTarget(): RemoteTarget {
  const url = process.env.LIBSQL_TEST_URL;
  if (url === undefined || url === '') {
    throw new Error(
      'LIBSQL_TEST_URL is not set. Start a throwaway libSQL server (for example ' +
        '`sqld --db-path /tmp/test.sqld --http-listen-addr 127.0.0.1:8080` or `turso dev`) and run ' +
        '`LIBSQL_TEST_URL=http://127.0.0.1:8080 pnpm test:remote`.',
    );
  }
  const host = new URL(url.replace(/^libsql:/, 'https:')).hostname;
  if (!LOOPBACK_HOSTS.has(host) && process.env.LIBSQL_TEST_ALLOW_WIPE !== '1') {
    throw new Error(
      `The remote suite wipes the database at ${host}. Set LIBSQL_TEST_ALLOW_WIPE=1 if that is a ` +
        'throwaway database.',
    );
  }
  const authToken = process.env.LIBSQL_TEST_AUTH_TOKEN;
  return { url, authToken: authToken === '' ? undefined : authToken };
}

/**
 * A raw HTTP client on the server under test: another writer that does not take this
 * process's write lock (like another serverless function instance).
 */
export function rawRemoteClient(): Client {
  const { url, authToken } = remoteTarget();
  return createHttpClient({ url, authToken });
}

/**
 * The server under test as another serverless function instance sees it: a client of its
 * own with a write lock of its own, so that this process's write lock does not order its
 * writes against the others' (only the server does).
 */
export function openInstance(): LibsqlDb {
  const { url, authToken } = remoteTarget();
  return guardedRemoteDb(createHttpClient({ url, authToken }), 'another instance');
}

/**
 * A Drizzle database over `client` guarded like the app guards a remote one
 * (`createLibsqlDatabase`), but with a write lock of its own named `lockName`, and without
 * the connection probes: the client is the test's, with a `fetch` of its own, perhaps.
 */
function guardedRemoteDb(client: Client, lockName: string): LibsqlDb {
  const guarded = guardClient(client, {
    lock: new WriteLock(lockName),
    lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
    serializeRootOperations: false,
    recycleAfterBusy: false,
  });
  return drizzle({ client: guarded, schema });
}

/** Opens the server under test with `createLibsqlDatabase`. */
export function openRemote(): Promise<LibsqlDatabase> {
  const { url, authToken } = remoteTarget();
  return createLibsqlDatabase({ url, authToken });
}

/** Drops every table, view and trigger of the database under test. */
export async function wipeRemoteDatabase(): Promise<void> {
  const client = rawRemoteClient();
  try {
    const objects = await client.execute(
      "SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view', 'table') AND name NOT LIKE 'sqlite_%'",
    );
    const order = ['trigger', 'view', 'table'];
    const drops = objects.rows
      .map((row) => ({
        type: typeof row.type === 'string' ? row.type : '',
        name: typeof row.name === 'string' ? row.name : '',
      }))
      .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
      .map(({ type, name }) => `DROP ${type.toUpperCase()} IF EXISTS "${name.replaceAll('"', '""')}"`);
    // `migrate` runs the batch with foreign keys off, so tables drop in any order.
    if (drops.length > 0) await client.migrate(drops);
  } finally {
    client.close();
  }
}

/**
 * Wipes the server under test and, with `migrate`, brings it to the schema of this build
 * with the `local` workspace, as the app opens a database.
 */
export async function resetRemoteDatabase(options: { migrate?: boolean } = {}): Promise<void> {
  await wipeRemoteDatabase();
  if (options.migrate !== true) return;
  const handle = await openRemote();
  try {
    await applyMigrations(handle.db);
    await ensureLocalWorkspace(handle.db);
  } finally {
    handle.close();
  }
}

/** Rows read and written as the server reports them per statement. */
export interface Usage {
  rowsRead: number;
  rowsWritten: number;
}

interface StatementResult {
  rows_read?: number;
  rows_written?: number;
}

interface PipelineResponse {
  results?: {
    type: string;
    response?: { type: string; result?: StatementResult & { step_results?: (StatementResult | null)[] } };
  }[];
}

/**
 * The server under test, opened like `createLibsqlDatabase` does but with a `fetch` that
 * adds up the rows each statement read and wrote (Hrana reports them per statement; Turso
 * bills them) in `usage`.
 */
export function openMetered(usage: Usage): LibsqlDb {
  const { url, authToken } = remoteTarget();
  const meteredFetch = async (input: Request): Promise<Response> => {
    const response = await fetch(input);
    const body = (await response.clone().json()) as PipelineResponse;
    for (const item of body.results ?? []) {
      const result = item.response?.result;
      for (const step of [result, ...(result?.step_results ?? [])]) {
        usage.rowsRead += step?.rows_read ?? 0;
        usage.rowsWritten += step?.rows_written ?? 0;
      }
    }
    return response;
  };
  return guardedRemoteDb(
    createHttpClient({ url, authToken, fetch: meteredFetch }),
    'metered remote database',
  );
}

/** The rows `operation` read and wrote, as `usage` (fed by {@link openMetered}) counts them. */
export async function measure<T>(usage: Usage, operation: () => Promise<T>): Promise<{ value: T } & Usage> {
  const before = { ...usage };
  const value = await operation();
  return {
    value,
    rowsRead: usage.rowsRead - before.rowsRead,
    rowsWritten: usage.rowsWritten - before.rowsWritten,
  };
}
