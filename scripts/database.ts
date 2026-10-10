/**
 * The database of the command-line scripts: the one the app's configuration names
 * (`TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`, else the file at `DATABASE_PATH`; read from
 * the environment and `.env*` files, see `./load-env`), opened like the app opens it.
 */
import { existsSync } from 'node:fs';

import type { AppConfig } from '@/server/config';
import { openDatabase } from '@/server/db/client';
import { databaseFileOf, describeDatabaseUrl, type LibsqlDatabase } from '@/server/db/libsql';
import { classifySqlError } from '@/server/db/sql-errors';

/** What the configured database is, safe to print (never a credential). */
export function describeConfiguredDatabase(config: AppConfig): string {
  return describeDatabaseUrl(config.database.url);
}

/**
 * Whether the configured database is a local file that does not exist yet (opening it
 * would create an empty one: usually a sign that `DATABASE_PATH` is wrong).
 */
export function isMissingDatabaseFile(config: AppConfig): boolean {
  const file = databaseFileOf(config.database.url);
  return file !== undefined && !existsSync(file);
}

/**
 * Opens the configured database as the app does: a local one is created if needed and
 * migrated, a remote one must be migrated already (`pnpm db:migrate`). The caller closes
 * the handle.
 */
export function openConfiguredDatabase(config: AppConfig): Promise<LibsqlDatabase> {
  return openDatabase({ url: config.database.url, authToken: config.database.authToken });
}

/**
 * A one-line description of a failure for the terminal. Database errors are described by
 * their driver message only: a Drizzle query error's own message embeds the SQL and its
 * bound parameters, which may be secrets (token hashes).
 */
export function describeFailure(error: unknown): string {
  return classifySqlError(error).message;
}
