/**
 * Which database the app opens, from the environment. Shared by the configuration, the
 * connection code and `drizzle.config.ts`, which drizzle-kit loads without the
 * `react-server` condition: so no `server-only` here, and no imports but Node's.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The local database file, relative to the working directory, when no URL is configured. */
export const DEFAULT_DATABASE_PATH = 'data/git-moxfield.db';

/** The URLs the app can open, for error messages. */
export const SUPPORTED_DATABASE_URLS_HINT =
  'libsql:, https:, http:, wss:, ws: (remote), file: or :memory: (local)';

/** The lower-case scheme of `url` (`libsql` for `libsql://…`), or `undefined` without one. */
export function databaseUrlScheme(url: string): string | undefined {
  return /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
}

/** How the libSQL client opens `url`; `undefined` for a URL the app cannot open. */
export function databaseUrlKind(url: string): 'memory' | 'file' | 'remote' | undefined {
  if (url === ':memory:') return 'memory';
  const scheme = databaseUrlScheme(url);
  if (scheme === 'file') return 'file';
  // `ws` and `wss` are served over `http` and `https`.
  const remote = scheme !== undefined && ['libsql', 'https', 'http', 'wss', 'ws'].includes(scheme);
  return remote ? 'remote' : undefined;
}

/** Which setting names the database. */
export type DatabaseLocationSource = 'TURSO_DATABASE_URL' | 'DATABASE_PATH';

/**
 * Where the database is: `TURSO_DATABASE_URL` (with `TURSO_AUTH_TOKEN`) when set, else the
 * file at `DATABASE_PATH` (default {@link DEFAULT_DATABASE_PATH}) as an absolute `file:`
 * URL. Empty values count as unset. The URL may carry credentials: never log it.
 */
export function databaseLocationFromEnv(env: Record<string, string | undefined>): {
  source: DatabaseLocationSource;
  url: string;
  authToken: string | undefined;
} {
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
