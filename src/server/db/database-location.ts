/**
 * Which database the app opens, from the environment: the URL schemes the libSQL client
 * accepts, the default database file and the rule that picks between a remote URL and a
 * local file. Shared by the app's configuration (`../config`), the connection code
 * (`./libsql`) and `drizzle.config.ts`, which drizzle-kit loads without the `react-server`
 * condition: it cannot import `server-only` modules, so this one has no such import and
 * needs nothing but Node's `path` and `url`.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The local database file, relative to the working directory, when no URL is configured. */
export const DEFAULT_DATABASE_PATH = 'data/git-moxfield.db';

/** URL schemes of remote libSQL servers (`ws` and `wss` are served over `http` and `https`). */
const REMOTE_DATABASE_SCHEMES: readonly string[] = ['libsql', 'https', 'http', 'wss', 'ws'];

/** The URLs the app can open, for error messages. */
export const SUPPORTED_DATABASE_URLS_HINT =
  'libsql:, https:, http:, wss:, ws: (remote), file: or :memory: (local)';

/** The in-memory database, which has no scheme. */
export const MEMORY_DATABASE_URL = ':memory:';

/** The lower-case scheme of `url` (`libsql` for `libsql://…`), or `undefined` without one. */
export function databaseUrlScheme(url: string): string | undefined {
  return /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
}

/** Whether the scheme names a remote libSQL server. */
export function isRemoteDatabaseScheme(scheme: string | undefined): boolean {
  return scheme !== undefined && REMOTE_DATABASE_SCHEMES.includes(scheme);
}

/** Whether `url` is one the app can open (see {@link SUPPORTED_DATABASE_URLS_HINT}). */
export function isSupportedDatabaseUrl(url: string): boolean {
  if (url === MEMORY_DATABASE_URL) return true;
  const scheme = databaseUrlScheme(url);
  return scheme === 'file' || isRemoteDatabaseScheme(scheme);
}

/** Which setting names the database. */
export type DatabaseLocationSource = 'TURSO_DATABASE_URL' | 'DATABASE_PATH';

export interface DatabaseLocationSetting {
  source: DatabaseLocationSource;
  /** The libSQL URL to open. May carry credentials: never log it. */
  url: string;
  /** Auth token of a remote database. Secret. */
  authToken: string | undefined;
}

/**
 * Where the database is: `TURSO_DATABASE_URL` (with `TURSO_AUTH_TOKEN`) when set, else the
 * file at `DATABASE_PATH` (default {@link DEFAULT_DATABASE_PATH}) as an absolute `file:`
 * URL. Empty values count as unset.
 */
export function databaseLocationFromEnv(env: Record<string, string | undefined>): DatabaseLocationSetting {
  const remoteUrl = env.TURSO_DATABASE_URL?.trim();
  if (remoteUrl !== undefined && remoteUrl !== '') {
    const authToken = env.TURSO_AUTH_TOKEN?.trim();
    return {
      source: 'TURSO_DATABASE_URL',
      url: remoteUrl,
      authToken: authToken === '' ? undefined : authToken,
    };
  }
  const path =
    env.DATABASE_PATH === undefined || env.DATABASE_PATH === '' ? DEFAULT_DATABASE_PATH : env.DATABASE_PATH;
  return { source: 'DATABASE_PATH', url: pathToFileURL(resolve(path)).href, authToken: undefined };
}
