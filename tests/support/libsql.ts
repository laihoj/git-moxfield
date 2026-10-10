/**
 * Test helpers for the libSQL plumbing in `src/server/db` (connection factory, error
 * classification, transactions, migration state). Used by the unit tests next to those
 * modules and by the opt-in remote suite (`tests/remote`).
 */
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq, sql } from 'drizzle-orm';

import type { LibsqlExecutor } from '@/server/db/libsql';
import * as schema from '@/server/db/schema';

/** A fresh, empty temporary directory. */
export function tempDir(prefix = 'git-moxfield-db-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A `file:` URL for a database in a fresh temporary directory (the file does not exist yet). */
export function tempFileUrl(name = 'test.db'): string {
  return `file:${join(tempDir(), name)}`;
}

export interface SeededHistory {
  readonly workspaceId: string;
  readonly deckId: string;
  readonly branchId: string;
  readonly commitId: string;
  readonly snapshotHash: string;
}

/**
 * Inserts a workspace, a deck with a main branch and one commit (with its snapshot and a
 * snapshot index row) through raw Drizzle inserts, bypassing the repositories. Enough to
 * exercise foreign keys, cascades and the immutability triggers.
 */
export async function seedDeckHistory(db: LibsqlExecutor, deckId = 'deck-1'): Promise<SeededHistory> {
  const at = '2026-01-01T00:00:00.000Z';
  const workspaceId = 'workspace-test';
  const branchId = `${deckId}-main`;
  const commitId = `${deckId}-commit-1`;
  const snapshotHash = `${deckId}-snapshot-1`;
  await db
    .insert(schema.workspaces)
    .values({ id: workspaceId, name: 'Test', createdAt: at })
    .onConflictDoNothing();
  await db.insert(schema.decks).values({
    id: deckId,
    workspaceId,
    source: 'moxfield',
    externalId: deckId,
    url: `https://moxfield.com/decks/${deckId}`,
    name: 'Test Deck',
    format: 'commander',
    createdAt: at,
    updatedAt: at,
  });
  await db
    .insert(schema.snapshots)
    .values({ hash: snapshotHash, schemaVersion: 1, canonicalJson: '{}', createdAt: at });
  await db
    .insert(schema.snapshotCards)
    .values({ snapshotHash, zone: 'mainboard', cardKey: 'sol ring', name: 'Sol Ring', quantity: 1 });
  await db
    .insert(schema.branches)
    .values({ id: branchId, deckId, name: 'main', kind: 'main', createdAt: at, updatedAt: at });
  await db.insert(schema.commits).values({
    id: commitId,
    deckId,
    branchId,
    sequence: 1,
    snapshotHash,
    message: 'Version 1',
    createdAt: at,
    ingestMethod: 'server',
    fetchedAt: at,
    sourceVersion: 1,
    sourceMetadataJson: '{}',
  });
  await db.update(schema.branches).set({ headCommitId: commitId }).where(eq(schema.branches.id, branchId));
  return { workspaceId, deckId, branchId, commitId, snapshotHash };
}

/** Rows of a table, counted with raw SQL. */
export async function countRows(db: LibsqlExecutor, table: string): Promise<number> {
  const rows = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM ${sql.identifier(table)}`);
  return rows[0]?.n ?? 0;
}

export interface HranaStub {
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  /** Pipeline requests received so far. */
  readonly requests: () => number;
  /** SQL of every statement executed so far, in order. */
  readonly statements: () => readonly string[];
  close(): Promise<void>;
}

export interface HranaStubOptions {
  /** What `PRAGMA foreign_keys` returns. Default 1. */
  foreignKeys?: 0 | 1;
  /** Statements that return no rows (default: every statement returns one row). */
  empty?: RegExp;
  /**
   * Answers every request with this HTTP status and no result instead (e.g. 401, as a
   * server does that refuses the token).
   */
  status?: number;
}

interface PipelineRequest {
  type: string;
  stmt?: { sql?: string };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

function integerResult(column: string, value: number | undefined): unknown {
  return {
    cols: [{ name: column, decltype: null }],
    rows: value === undefined ? [] : [[{ type: 'integer', value: String(value) }]],
    affected_row_count: 0,
    last_insert_rowid: null,
  };
}

/**
 * A minimal libSQL server (Hrana 2 over HTTP, JSON) that answers every statement with one
 * integer row: `PRAGMA foreign_keys` with `foreignKeys`, statements matching `empty` with
 * no rows, anything else with 1. Enough to open a remote database without a real server.
 * With `status`, it answers every request with that HTTP status instead.
 */
export async function startHranaStub(options: HranaStubOptions = {}): Promise<HranaStub> {
  let requests = 0;
  const statements: string[] = [];
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (options.status !== undefined) {
      requests++;
      response.writeHead(options.status).end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v2/pipeline') {
      response.writeHead(404).end();
      return;
    }
    requests++;
    const body = JSON.parse(await readBody(request)) as { requests: PipelineRequest[] };
    const results = body.requests.map((item) => {
      if (item.type === 'close') return { type: 'ok', response: { type: 'close' } };
      if (item.type === 'execute') {
        const statement = item.stmt?.sql ?? '';
        statements.push(statement);
        const isForeignKeys = /^\s*PRAGMA\s+foreign_keys\s*;?\s*$/i.test(statement);
        const result = isForeignKeys
          ? integerResult('foreign_keys', options.foreignKeys ?? 1)
          : integerResult('1', options.empty?.test(statement) === true ? undefined : 1);
        return { type: 'ok', response: { type: 'execute', result } };
      }
      return { type: 'error', error: { message: `Unsupported request ${item.type}`, code: 'UNSUPPORTED' } };
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ baton: null, base_url: null, results }));
  };
  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => requests,
    statements: () => [...statements],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

/** A loopback URL on which nothing listens (connections are refused). */
export async function refusingUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return `http://127.0.0.1:${port}`;
}

export interface EntryProbe {
  readonly kind: string;
  readonly foreignKeys: number;
  /** Loaded libSQL native code: the `libsql` package's loader and `.node` binaries. */
  readonly nativeModules: readonly string[];
}

const LIBSQL_MODULE = join(process.cwd(), 'src/server/db/libsql.ts');

const PROBE = `
import { createRequire } from 'node:module';
const { createLibsqlDatabase } = await import(process.env.PROBE_MODULE);
const handle = await createLibsqlDatabase({
  url: process.env.PROBE_URL,
  authToken: process.env.PROBE_AUTH_TOKEN || undefined,
});
const result = await handle.client.execute('PRAGMA foreign_keys');
handle.close();
const cached = Object.keys(createRequire(process.cwd() + '/').cache);
const shared = process.report.getReport().sharedObjects;
const nativeModules = [...cached, ...shared].filter(
  (path) => /libsql/i.test(path) && (/\\.node$/.test(path) || /[\\\\/]libsql[\\\\/]index\\.js$/.test(path)),
);
process.stdout.write(JSON.stringify({ kind: handle.kind, foreignKeys: Number(result.rows[0][0]), nativeModules }));
`;

/**
 * Opens `url` with `createLibsqlDatabase` in a fresh Node process (as a serverless
 * function would) and reports which libSQL native code that process loaded. Pass the
 * `authToken` of a server that requires one (Turso always does).
 */
export function probeDatabaseEntryInChildProcess(url: string, authToken?: string): Promise<EntryProbe> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', '--conditions=react-server', '--input-type=module', '--eval', PROBE],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PROBE_URL: url,
          PROBE_AUTH_TOKEN: authToken ?? '',
          PROBE_MODULE: LIBSQL_MODULE,
        },
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`The probe process failed: ${error.message}\n${stderr}`));
          return;
        }
        resolve(JSON.parse(stdout) as EntryProbe);
      },
    );
  });
}

const HOLDER = `
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/');
const { createClient } = await import(require.resolve('@libsql/client/sqlite3'));
const client = createClient({ url: process.env.HOLDER_URL });
const transaction = await client.transaction('write');
await transaction.execute("INSERT INTO items (name) VALUES ('from the other process')");
process.stdout.write('locked\\n');
setTimeout(async () => {
  await transaction.commit();
  client.close();
}, Number(process.env.HOLDER_MS));
`;

export interface LockHolder {
  /** Resolves when the other process has committed and exited. */
  readonly exited: Promise<void>;
}

/**
 * Starts another Node process that opens the local database `url`, inserts
 * `'from the other process'` into its `items` table in a write transaction, holds the
 * write lock for `holdMs` and commits. Resolves once the lock is held.
 */
export function holdWriteLockInChildProcess(url: string, holdMs: number): Promise<LockHolder> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['--input-type=module', '--eval', HOLDER], {
      cwd: process.cwd(),
      env: { ...process.env, HOLDER_URL: url, HOLDER_MS: String(holdMs) },
      timeout: 30_000,
    });
    const exited = new Promise<void>((done, fail) => {
      child.on('exit', (code) => {
        if (code === 0) done();
        else fail(new Error(`The lock holder exited with code ${String(code)}`));
      });
    });
    child.stdout?.once('data', () => {
      resolve({ exited });
    });
    child.on('error', reject);
    exited.catch(reject);
  });
}
