import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startHranaStub, tempDir, type HranaStub } from '@tests/support/libsql';

import { resetConfigForTests } from '../config';
import { ensureLocalWorkspace, getDb, LOCAL_WORKSPACE_ID, openDatabase, resetDbForTests } from './client';
import { DatabaseConfigError, type LibsqlDatabase } from './libsql';
import { bundledMigrations, checkMigrationState, MigrationStateError } from './migration-state';
import { workspaces } from './schema';

const opened: LibsqlDatabase[] = [];
const stubs: HranaStub[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const handle of opened.splice(0)) handle.close();
  await Promise.all(stubs.splice(0).map((stub) => stub.close()));
  await resetDbForTests();
  vi.unstubAllEnvs();
  resetConfigForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function open(url: string): Promise<LibsqlDatabase> {
  const handle = await openDatabase({ url });
  opened.push(handle);
  return handle;
}

/** A database file path in a fresh temporary directory, removed after the test. */
function tempDatabasePath(): string {
  const dir = tempDir('git-moxfield-client-');
  dirs.push(dir);
  return join(dir, 'app.db');
}

function fileUrl(): string {
  return `file:${tempDatabasePath()}`;
}

async function localWorkspaces(handle: LibsqlDatabase): Promise<unknown[]> {
  return handle.db.select().from(workspaces).where(eq(workspaces.id, LOCAL_WORKSPACE_ID)).all();
}

describe('openDatabase', () => {
  it('migrates a new local database and creates the local workspace', async () => {
    const handle = await open(':memory:');
    expect(handle.kind).toBe('local');
    expect((await checkMigrationState(handle.db)).status).toBe('up-to-date');
    expect(await localWorkspaces(handle)).toEqual([
      { id: LOCAL_WORKSPACE_ID, name: 'Local', createdAt: expect.any(String) as string },
    ]);
  });

  it('reopens a local file without migrating or seeding it again', async () => {
    const url = fileUrl();
    const first = await open(url);
    const [created] = await localWorkspaces(first);
    first.close();

    const second = await open(url);
    expect(await localWorkspaces(second)).toEqual([created]);
    const recorded = await second.db.all(sql`SELECT COUNT(*) AS n FROM __drizzle_migrations`);
    expect(recorded).toEqual([{ n: bundledMigrations().length }]);
  });

  it('never migrates a remote database: it refuses one that is not up to date', async () => {
    // A server whose database has no tables yet.
    const stub = await startHranaStub({ empty: /sqlite_master|__drizzle_migrations/ });
    stubs.push(stub);

    const failure = openDatabase({ url: stub.url });
    await expect(failure).rejects.toBeInstanceOf(MigrationStateError);
    await expect(failure).rejects.toThrow(
      'The database has not been migrated yet. Run `pnpm db:migrate` against it.',
    );
    const sent = stub.statements();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((statement) => !/^\s*(SELECT|PRAGMA foreign_keys\s*$)/i.test(statement))).toEqual([]);
  });

  it('creates the local workspace only when it is missing', async () => {
    const handle = await open(':memory:');
    await handle.db.delete(workspaces).where(eq(workspaces.id, LOCAL_WORKSPACE_ID));
    await ensureLocalWorkspace(handle.db);
    await ensureLocalWorkspace(handle.db);
    expect(await localWorkspaces(handle)).toHaveLength(1);
  });
});

describe('getDb', () => {
  it('opens the configured database once and shares it', async () => {
    vi.stubEnv('DATABASE_PATH', tempDatabasePath());
    resetConfigForTests();

    const [a, b] = await Promise.all([getDb(), getDb()]);
    expect(a).toBe(b);
    expect(await getDb()).toBe(a);
    expect((await checkMigrationState(a)).status).toBe('up-to-date');
  });

  it('refuses the implicit local file on Netlify, and tries again on the next call', async () => {
    vi.stubEnv('DATABASE_PATH', tempDatabasePath());
    vi.stubEnv('TURSO_DATABASE_URL', '');
    vi.stubEnv('SITE_ID', 'site-1234');
    resetConfigForTests();

    await expect(getDb()).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(getDb()).rejects.toThrow(/TURSO_DATABASE_URL is not set/);

    vi.stubEnv('SITE_ID', '');
    expect(await getDb()).toBeDefined();
  });

  it('opens an explicit TURSO_DATABASE_URL on Netlify, even a local one', async () => {
    vi.stubEnv('TURSO_DATABASE_URL', fileUrl());
    vi.stubEnv('NETLIFY', 'true');
    resetConfigForTests();
    expect((await checkMigrationState(await getDb())).status).toBe('up-to-date');
  });
});
