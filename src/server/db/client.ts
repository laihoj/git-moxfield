/**
 * The app's database (ADR 0008): opened lazily on first use, never at import time (so
 * `next build` has no database side effects), and memoized on `globalThis` so that it
 * survives dev-server HMR.
 *
 * Where: `TURSO_DATABASE_URL` (+ `TURSO_AUTH_TOKEN`) when set, else the local file at
 * `DATABASE_PATH` (see `DatabaseLocation` in `../config`).
 *
 * Migrations: a **local** database (`file:`, `:memory:`) is migrated when it is opened, a
 * development convenience. A **remote** database (Turso, any libSQL server) is never
 * migrated at runtime: concurrent cold starts would race, and the integrity check after
 * migrating reads every row. The deploy step migrates it (`pnpm db:migrate`); the app only
 * checks that every migration it ships is applied and refuses to work otherwise, with a
 * message that says so. Newer migrations (a database `ahead` of this build) are logged and
 * tolerated: they are backward compatible with the deploy that was live when they ran, which
 * keeps that deploy working until the next one is published, and after a rollback.
 */
import 'server-only';

import { eq } from 'drizzle-orm';

import { getConfig, type AppConfig, type DatabaseLocation } from '../config';
import { createLogger } from '../logger';
import { runsOnNetlify } from '../platform';
import {
  createLibsqlDatabase,
  DatabaseConfigError,
  type LibsqlDatabase,
  type LibsqlDatabaseOptions,
  type LibsqlDb,
} from './libsql';
import { applyMigrations, assertMigrationsApplied } from './migration-state';
import { workspaces } from './schema';
import { runWrite } from './transaction';

/** The app's root database (see {@link getDb}); repositories accept any `LibsqlExecutor`. */
export type Db = LibsqlDb;

/**
 * The workspace of installations from before accounts. Every database has it (it is
 * created when the database is opened); the first admin adopts it when it holds history.
 */
export const LOCAL_WORKSPACE_ID = 'local';

export interface OpenDatabaseOptions extends LibsqlDatabaseOptions {
  /**
   * Local databases only: the folder with the migrations to apply and their journal.
   * Default: `drizzle/` in the working directory. A remote database is always checked
   * against the migrations this build ships.
   */
  migrationsFolder?: string;
  /**
   * Only check that the database is migrated, as for a remote one, whatever its kind:
   * never migrate it and never write to it (a dry run). Default: false.
   */
  verifyOnly?: boolean;
}

/**
 * Creates the `local` workspace unless it exists. A read first, so that an existing
 * database (the usual case) is not written to and never waits for the write lock.
 */
export async function ensureLocalWorkspace(db: LibsqlDb): Promise<void> {
  const existing = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, LOCAL_WORKSPACE_ID))
    .get();
  if (existing) return;
  await runWrite(db, async (root) => {
    await root
      .insert(workspaces)
      .values({ id: LOCAL_WORKSPACE_ID, name: 'Local', createdAt: new Date().toISOString() })
      .onConflictDoNothing();
  });
}

/**
 * Opens a database for the app, a script or a test: verifies it (`createLibsqlDatabase`),
 * migrates a local one or checks that a remote one has every migration of this build
 * (logging a warning when it also has newer ones), and makes sure the
 * `local` workspace exists. Pass `{ url: ':memory:' }` for an isolated in-memory database.
 * The caller owns the handle and closes it.
 *
 * @throws {DatabaseConfigError} for an unusable URL or database.
 * @throws {MigrationStateError} when a migration of this build is not applied to a remote
 *   database (the message says to run `pnpm db:migrate`), or a local one was migrated by a
 *   newer build.
 * @throws {Error} when migrating a local database fails (the migration batch is rolled back)
 *   or leaves dangling references.
 */
export async function openDatabase(options: OpenDatabaseOptions): Promise<LibsqlDatabase> {
  const { migrationsFolder, verifyOnly = false, ...connection } = options;
  const handle = await createLibsqlDatabase(connection);
  try {
    if (handle.kind === 'local' && !verifyOnly) {
      await applyMigrations(handle.db, migrationsFolder === undefined ? {} : { migrationsFolder });
    } else {
      const state = await assertMigrationsApplied(handle.db);
      if (state.status === 'ahead') {
        createLogger('db').warn(
          'The database has migrations newer than this build. Serving it: migrations stay ' +
            'compatible with the previous deploy (expand, then contract). Expected while a new ' +
            'deploy is being published, or after rolling back to an earlier one.',
          { migrations: { applied: state.applied, shipped: state.expected, newer: state.unknown } },
        );
      }
    }
    if (!verifyOnly) await ensureLocalWorkspace(handle.db);
    return handle;
  } catch (error) {
    handle.close();
    throw error;
  }
}

/**
 * Refuses the implicit local file on Netlify: a function's file system is ephemeral and
 * per instance, so a database there would appear to work and lose its data. An explicit
 * `TURSO_DATABASE_URL` (even a `file:` one) is the operator's choice and allowed.
 */
function assertDurableLocation(location: DatabaseLocation): void {
  if (location.source === 'DATABASE_PATH' && runsOnNetlify()) {
    throw new DatabaseConfigError(
      'TURSO_DATABASE_URL is not set. On Netlify the database must be a Turso (libSQL) ' +
        "database: a local file would live on a function's temporary disk and lose its data. " +
        'Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the site settings (docs/adr/0008).',
    );
  }
}

/**
 * Opens the database `config` names, as {@link openDatabase} does; the caller closes it.
 * @throws {DatabaseConfigError} also on Netlify without `TURSO_DATABASE_URL`.
 */
export async function openConfiguredDatabase(
  config: AppConfig = getConfig(),
  options: Pick<OpenDatabaseOptions, 'verifyOnly'> = {},
): Promise<LibsqlDatabase> {
  assertDurableLocation(config.database);
  return openDatabase({ ...config.database.connection(), ...options });
}

const globalForDb = globalThis as unknown as { __gitMoxfieldDatabase?: Promise<LibsqlDatabase> };

/**
 * Test hook: closes the app's database (if it is open) and forgets it, so that the next
 * {@link getDb} opens it again with the then current configuration.
 */
export async function resetDbForTests(): Promise<void> {
  const opening = globalForDb.__gitMoxfieldDatabase;
  globalForDb.__gitMoxfieldDatabase = undefined;
  const handle = await opening?.catch(() => undefined);
  handle?.close();
}

/**
 * The app's database, opened on first use and shared by every request of the process.
 *
 * A failed opening is not memoized: the next call tries again, so a database that was
 * unreachable or not yet migrated (`pnpm db:migrate`) is picked up without a restart.
 *
 * @throws what {@link openDatabase} throws, and {@link DatabaseConfigError} on Netlify
 *   without `TURSO_DATABASE_URL`.
 */
export async function getDb(): Promise<LibsqlDb> {
  let opening = globalForDb.__gitMoxfieldDatabase;
  if (opening === undefined) {
    opening = openConfiguredDatabase();
    globalForDb.__gitMoxfieldDatabase = opening;
    void opening.catch(() => {
      if (globalForDb.__gitMoxfieldDatabase === opening) globalForDb.__gitMoxfieldDatabase = undefined;
    });
  }
  return (await opening).db;
}
