/**
 * Applies the database migrations in `drizzle/` to the configured database and reports
 * what was applied:
 *
 *   pnpm db:migrate
 *
 * The database is the one the app uses: `TURSO_DATABASE_URL` (+ `TURSO_AUTH_TOKEN`) when
 * set, else the local file at `DATABASE_PATH` (default `data/git-moxfield.db`), read from
 * the environment and `.env*` files like the app does.
 *
 * - A **remote** database (Turso) is never migrated by the app; this script is how it gets
 *   migrated. Netlify runs it after every successful production build (`netlify.toml`).
 * - A **local** database is migrated by the app when it opens it as well; this script
 *   makes the step explicit for backups and troubleshooting.
 *
 * On Netlify (`NETLIFY=true` in builds) it refuses a local database: the build container's
 * disk is thrown away after the build, so "migrating" a file there would report success
 * while the real (Turso) database stays unmigrated, typically because `TURSO_DATABASE_URL`
 * is not set for the build.
 *
 * Migrations are applied in one atomic batch; when something was applied, referential
 * integrity is verified (`PRAGMA foreign_key_check`). Not safe to run from two processes
 * against the same database at once (run it from one deploy step). Exits with code 1 and
 * a message when migrating fails, the database cannot be reached, or it was migrated by a
 * newer git-moxfield.
 */

import { getConfig, type AppConfig } from '@/server/config';
import { ensureLocalWorkspace } from '@/server/db/client';
import { createLibsqlDatabase, databaseKindOf, type LibsqlDatabase } from '@/server/db/libsql';
import { applyMigrations } from '@/server/db/migration-state';
import { runsOnNetlify, type PlatformEnv } from '@/server/platform';

import { describeConfiguredDatabase, describeFailure, isMissingDatabaseFile } from './database';
import { isEntryPoint, runMain } from './cli';
import { loadEnvFiles } from './load-env';

export interface MigrateCommandIO {
  out(line: string): void;
  err(line: string): void;
}

export interface MigrateCommandDependencies {
  config: AppConfig;
  /** The process environment, to tell where the script runs. Default: `process.env`. */
  env?: PlatformEnv;
  io: MigrateCommandIO;
  /** Folder with the migrations and their journal. Default: `drizzle/` in the working directory. */
  migrationsFolder?: string;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Why `config`'s database must not be migrated from this process, or `null` when it may:
 * on Netlify only a remote database is durable.
 */
function refusal(config: AppConfig, env: PlatformEnv): string | null {
  if (!runsOnNetlify(env) || databaseKindOf(config.database.url) !== 'local') return null;
  return config.database.source === 'DATABASE_PATH'
    ? 'TURSO_DATABASE_URL is not set, so this would migrate a local database file in the ' +
        "Netlify build container, which is thrown away after the build, while the app's Turso " +
        'database stays unmigrated. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the Netlify ' +
        'site settings (docs/adr/0008-hosting-netlify-and-turso.md).'
    : 'TURSO_DATABASE_URL names a local database, which does not survive the Netlify build ' +
        'container. Point it at the Turso database (libsql://<database>-<organization>.turso.io).';
}

/** Runs `pnpm db:migrate`. @returns the process exit code. */
export async function runMigrateCommand(deps: MigrateCommandDependencies): Promise<number> {
  const { config, io } = deps;
  let description: string;
  let refused: string | null;
  try {
    description = describeConfiguredDatabase(config);
    refused = refusal(config, deps.env ?? process.env);
  } catch (error) {
    io.err(describeFailure(error));
    return 1;
  }
  if (refused !== null) {
    io.err(`Refusing to migrate the ${description}: ${refused}`);
    return 1;
  }

  // A new file usually means DATABASE_PATH does not point at the app's database.
  const created = isMissingDatabaseFile(config);
  let handle: LibsqlDatabase;
  try {
    handle = await createLibsqlDatabase({ url: config.database.url, authToken: config.database.authToken });
  } catch (error) {
    io.err(`Could not open the ${description}: ${describeFailure(error)}`);
    return 1;
  }
  try {
    io.out(created ? `Created a new ${description}` : `Migrating the ${description}`);
    const { applied, state } = await applyMigrations(
      handle.db,
      deps.migrationsFolder === undefined ? {} : { migrationsFolder: deps.migrationsFolder },
    );
    await ensureLocalWorkspace(handle.db);
    if (applied.length === 0) {
      io.out(`Already up to date (${plural(state.expected, 'migration')} applied).`);
      return 0;
    }
    io.out(`Applied ${plural(applied.length, 'migration')}:`);
    for (const tag of applied) io.out(`  ${tag}`);
    io.out('Referential integrity verified (PRAGMA foreign_key_check).');
    io.out(`Up to date: all ${plural(state.expected, 'migration')} applied.`);
    return 0;
  } catch (error) {
    io.err(`Migrating the ${description} failed: ${describeFailure(error)}`);
    return 1;
  } finally {
    handle.close();
  }
}

async function main(): Promise<number> {
  const io: MigrateCommandIO = {
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
  };
  let config: AppConfig;
  try {
    loadEnvFiles();
    config = getConfig();
  } catch (error) {
    io.err(describeFailure(error));
    return 1;
  }
  return runMigrateCommand({ config, io });
}

// Run only as a script (`pnpm db:migrate`), not when imported by tests.
if (isEntryPoint(import.meta.url)) runMain('db:migrate', main);
