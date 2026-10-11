/**
 * The database of the command-line scripts: the one the app's configuration names
 * (`TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`, else the file at `DATABASE_PATH`; read from
 * the environment and `.env*` files, see `./load-env`), opened like the app opens it.
 */
import { existsSync } from 'node:fs';

import { getConfig, type AppConfig } from '@/server/config';
import { openConfiguredDatabase } from '@/server/db/client';
import { databaseFileOf, databaseKindOf, describeDatabaseUrl, type LibsqlDatabase } from '@/server/db/libsql';
import { classifySqlError, connectionFailureOf } from '@/server/db/sql-errors';

import type { CommandIO } from './cli';
import { loadEnvFiles } from './load-env';

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
 * The app's configuration for a script (the environment and the `.env*` files, see
 * `./load-env`), or `null` after reporting to `io.err` why it is not usable.
 */
export function loadConfigOrReport(io: CommandIO): AppConfig | null {
  try {
    loadEnvFiles();
    return getConfig();
  } catch (error) {
    io.err(describeFailure(error));
    return null;
  }
}

/**
 * Opens the configured database as the app does (see `openConfiguredDatabase`), or `null`
 * after reporting to `io.err` why it could not be opened. The caller closes the handle.
 */
export async function openConfiguredDatabaseOrReport(
  config: AppConfig,
  io: CommandIO,
  options: Parameters<typeof openConfiguredDatabase>[1] = {},
): Promise<LibsqlDatabase | null> {
  try {
    return await openConfiguredDatabase(config, options);
  } catch (error) {
    io.err(`Could not open the ${describeConfiguredDatabase(config)}: ${describeFailure(error, config)}`);
    return null;
  }
}

/**
 * A one-line description of a failure for the terminal. Database errors are described by
 * their driver message only: a Drizzle query error's own message embeds the SQL and its
 * bound parameters, which may be secrets (token hashes). With the configuration, a remote
 * database that refused the credentials or could not be reached also gets what to check,
 * naming the variables (see {@link connectionHint}).
 */
export function describeFailure(error: unknown, config?: AppConfig): string {
  const message = classifySqlError(error).message;
  const hint = config === undefined ? undefined : connectionHint(error, config);
  return hint === undefined ? message : `${message.replace(/\.$/, '')}. ${hint}`;
}

/** Where tokens come from, for the hints. */
const CREATE_TOKEN = 'Create a token with `turso db tokens create <database>`';
/** Where the URL comes from, for the hints. */
const SHOW_URL = '`turso db show <database> --url` prints it: libsql://<database>-<organization>.turso.io';

/**
 * What to check when the configured remote database refused the credentials, does not
 * exist or could not be reached, naming the variables to fix; `undefined` for any other
 * failure (and for local databases).
 */
export function connectionHint(error: unknown, config: AppConfig): string | undefined {
  const failure = connectionFailureOf(error);
  if (failure === undefined || databaseKindOf(config.database.url) !== 'remote') return undefined;
  switch (failure) {
    case 'unauthorized':
      return config.database.authToken === undefined
        ? `The database needs a token, and TURSO_AUTH_TOKEN is not set. ${CREATE_TOKEN} and set ` +
            'TURSO_AUTH_TOKEN to it (on Netlify: Project configuration › Environment variables, ' +
            'for builds and functions).'
        : 'The database refused TURSO_AUTH_TOKEN: it has expired, was invalidated, or belongs to ' +
            `another database than the one TURSO_DATABASE_URL names. ${CREATE_TOKEN} and replace ` +
            'TURSO_AUTH_TOKEN with it.';
    case 'forbidden':
      return (
        'TURSO_AUTH_TOKEN is not allowed to do this; a read-only token cannot migrate or write. ' +
        `${CREATE_TOKEN} (without --read-only) and replace TURSO_AUTH_TOKEN with it.`
      );
    case 'not-found':
      return `No database answers at TURSO_DATABASE_URL. Check its database and organization names (${SHOW_URL}).`;
    case 'unreachable':
      return (
        'The host TURSO_DATABASE_URL names could not be reached. Check the URL ' +
        `(${SHOW_URL}) and the network connection.`
      );
  }
}
