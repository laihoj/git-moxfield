import { join } from 'node:path';

import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openTestDatabaseHandle } from '@tests/support/db';
import { scratchDir, scratchFileUrl, startHranaStub } from '@tests/support/libsql';

import { resetConfigForTests } from '../config';
import { ensureLocalWorkspace, getDb, LOCAL_WORKSPACE_ID, openDatabase, resetDbForTests } from './client';
import { DatabaseConfigError, type LibsqlDatabase } from './libsql';
import { bundledMigrations, checkMigrationState, MigrationStateError } from './migration-state';
import { workspaces } from './schema';

afterEach(async () => {
  await resetDbForTests();
  vi.unstubAllEnvs();
  resetConfigForTests();
});

/** A database file path in a fresh scratch directory. */
function tempDatabasePath(): string {
  return join(scratchDir('git-moxfield-client-'), 'app.db');
}

async function localWorkspaces(handle: LibsqlDatabase): Promise<unknown[]> {
  return handle.db.select().from(workspaces).where(eq(workspaces.id, LOCAL_WORKSPACE_ID)).all();
}

describe('openDatabase', () => {
  it('migrates a new local database and creates the local workspace', async () => {
    const handle = await openTestDatabaseHandle({ url: ':memory:' });
    expect(handle.kind).toBe('local');
    expect((await checkMigrationState(handle.db)).status).toBe('up-to-date');
    expect(await localWorkspaces(handle)).toEqual([
      { id: LOCAL_WORKSPACE_ID, name: 'Local', createdAt: expect.any(String) as string },
    ]);
  });

  it('reopens a local file without migrating or seeding it again', async () => {
    const url = scratchFileUrl('app.db');
    const first = await openTestDatabaseHandle({ url });
    const [created] = await localWorkspaces(first);
    first.close();

    const second = await openTestDatabaseHandle({ url });
    expect(await localWorkspaces(second)).toEqual([created]);
    const recorded = await second.db.all(sql`SELECT COUNT(*) AS n FROM __drizzle_migrations`);
    expect(recorded).toEqual([{ n: bundledMigrations().length }]);
  });

  it('never migrates a remote database: it refuses one that is not up to date', async () => {
    // A server whose database has no tables yet.
    const stub = await startHranaStub({ empty: /sqlite_master|__drizzle_migrations/ });

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
    const handle = await openTestDatabaseHandle({ url: ':memory:' });
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
    vi.stubEnv('TURSO_DATABASE_URL', scratchFileUrl('app.db'));
    vi.stubEnv('NETLIFY', 'true');
    resetConfigForTests();
    expect((await checkMigrationState(await getDb())).status).toBe('up-to-date');
  });
});
