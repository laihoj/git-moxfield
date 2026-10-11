/**
 * Typed, validated server configuration from environment variables.
 * Server-only: never import from client components (it would leak nothing secret,
 * but `MOXFIELD_USER_AGENT` must stay on the server by policy).
 */
import 'server-only';

import { z } from 'zod';

import { stripTrailingSlashes } from '@/core/http-url';
import { LOG_LEVELS } from '@/core/logger';
import {
  DEFAULT_MOXFIELD_API_BASE_URL,
  DEFAULT_MOXFIELD_BLOCK_BACKOFF_SECONDS,
  DEFAULT_MOXFIELD_MIN_REQUEST_INTERVAL_MS,
  DEFAULT_MOXFIELD_SITE_ORIGIN,
  DEFAULT_MOXFIELD_TIMEOUT_MS,
} from '@/integrations/moxfield/constants';

import {
  DEFAULT_DATABASE_PATH,
  databaseLocationFromEnv,
  isSupportedDatabaseUrl,
  SUPPORTED_DATABASE_URLS_HINT,
  type DatabaseLocationSource,
} from './db/database-location';
import { invalidAllowedHosts, splitList } from './host-guard';
import { runsOnNetlify } from './platform';

const boolish = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
  .transform((v) => ['true', '1', 'yes', 'on'].includes(v));

/** An absolute http(s) URL (a base URL of the app or of Moxfield): other schemes fail at startup. */
const httpUrl = () => z.url({ protocol: /^https?$/ });

const schema = z.object({
  /** Local SQLite database file, used when `TURSO_DATABASE_URL` is not set. */
  DATABASE_PATH: z.string().min(1).default(DEFAULT_DATABASE_PATH),
  /**
   * libSQL URL of the database: `libsql://<db>-<org>.turso.io` (Turso, in production),
   * `http://127.0.0.1:8080` (a local libSQL server such as `turso dev`) or `file:path.db`.
   * When unset, the database is the file at `DATABASE_PATH`. The value is never echoed in
   * errors or logs (a URL may carry an `authToken` query parameter).
   */
  TURSO_DATABASE_URL: z
    .string()
    .trim()
    .min(1)
    .optional()
    .refine((value) => value === undefined || isSupportedDatabaseUrl(value), {
      message: `expected a URL using ${SUPPORTED_DATABASE_URLS_HINT}`,
    }),
  /** Auth token for `TURSO_DATABASE_URL` (Turso). Secret: only reachable through {@link AppConfig.database}. */
  TURSO_AUTH_TOKEN: z.string().trim().min(1).optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  /** Base URL of the Moxfield API. Overridden in tests to point at the mock server. */
  MOXFIELD_API_BASE_URL: httpUrl().default(DEFAULT_MOXFIELD_API_BASE_URL).transform(stripTrailingSlashes),
  /** Origin of the Moxfield website (deck URLs, capture origin check). */
  MOXFIELD_SITE_ORIGIN: httpUrl().default(DEFAULT_MOXFIELD_SITE_ORIGIN),
  /** User-Agent issued by Moxfield for approved projects. Server-side only. */
  MOXFIELD_USER_AGENT: z.string().trim().min(1).optional(),
  /**
   * `auto`: try server fetches, back off when blocked. `off`: browser capture only.
   * Default: `off` on Netlify (Cloudflare blocks Moxfield requests from cloud IPs, so every
   * attempt would only cost a request and a block backoff), `auto` everywhere else.
   */
  MOXFIELD_SERVER_FETCH: z.enum(['auto', 'off']).optional(),
  MOXFIELD_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(DEFAULT_MOXFIELD_TIMEOUT_MS),
  /** Minimum spacing between any two requests to Moxfield from this process. */
  MOXFIELD_MIN_REQUEST_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(60_000)
    .default(DEFAULT_MOXFIELD_MIN_REQUEST_INTERVAL_MS),
  /** How long to pause server fetches after a bot-protection block. */
  MOXFIELD_BLOCK_BACKOFF_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(86_400)
    .default(DEFAULT_MOXFIELD_BLOCK_BACKOFF_SECONDS),

  /** Minimum seconds between two refreshes of the same deck. */
  REFRESH_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3_600).default(10),
  /** Deck pages trigger a background refresh when the latest observation is older than this. */
  AUTO_REFRESH_AFTER_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),

  /** Comma-separated origins allowed to hand captured decks to /capture. Defaults to the Moxfield site origin. */
  CAPTURE_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .superRefine((value, ctx) => {
      const invalid = splitList(value).filter((entry) => !URL.canParse(entry));
      if (invalid.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `expected origins such as https://moxfield.com, got ${invalid.map((v) => JSON.stringify(v)).join(', ')}`,
        });
      }
    }),
  /** Public URL of this app, baked into bookmarklets. Defaults to the request origin. */
  PUBLIC_APP_URL: httpUrl().transform(stripTrailingSlashes).optional(),
  /**
   * Comma-separated host names (ports ignored) the app may be reached under besides IP
   * addresses, `localhost`/`*.localhost` and the host of `PUBLIC_APP_URL`, e.g. an mDNS
   * name or a reverse proxy's domain. Requests for any other host get 421 (the
   * DNS-rebinding guard in `src/proxy.ts`, which reads the variable directly).
   */
  ALLOWED_HOSTS: z
    .string()
    .optional()
    .superRefine((value, ctx) => {
      const invalid = invalidAllowedHosts(value);
      if (invalid.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `expected host names such as mybox.local, got ${invalid.map((v) => JSON.stringify(v)).join(', ')}`,
        });
      }
    }),

  /**
   * Enables the end-to-end suite's test-only endpoints (`/api/e2e/*`: reset, signing in
   * a new user, reading the setup code; see `src/app/api/e2e/`). Refused (the server does
   * not start) when `NODE_ENV=production`; production builds never serve the endpoints
   * anyway (`src/app/api/e2e/guard.ts`).
   */
  GIT_MOXFIELD_E2E: boolish.optional(),
  /** Read only to refuse `GIT_MOXFIELD_E2E` in production (Next.js sets it). */
  NODE_ENV: z.string().optional(),
});

/**
 * Where the database is: `TURSO_DATABASE_URL` (with `TURSO_AUTH_TOKEN`) when set, else the
 * file at `DATABASE_PATH`. The URL and the token are private fields, so they never show up
 * when the configuration is logged, serialized or inspected; log
 * `describeDatabaseUrl(location.url)` (`src/server/db/libsql.ts`) instead.
 */
export class DatabaseLocation {
  readonly #url: string;
  readonly #authToken: string | undefined;
  /** The setting the location comes from. */
  readonly source: DatabaseLocationSource;

  constructor(source: DatabaseLocationSource, url: string, authToken?: string) {
    this.source = source;
    this.#url = url;
    this.#authToken = authToken;
  }

  /** The libSQL URL to open. May carry credentials: never log it. */
  get url(): string {
    return this.#url;
  }

  /** Auth token for a remote database (`TURSO_AUTH_TOKEN`), if any. Secret. */
  get authToken(): string | undefined {
    return this.#authToken;
  }

  /** What opening the database needs (`createLibsqlDatabase`). Holds the secrets: never log it. */
  connection(): { url: string; authToken: string | undefined } {
    return { url: this.#url, authToken: this.#authToken };
  }

  /** What `JSON.stringify` (and so the logger) shows: never the URL or the token. */
  toJSON(): { source: DatabaseLocationSource } {
    return { source: this.source };
  }
}

type ParsedEnv = z.infer<typeof schema>;

export type AppConfig = Omit<
  ParsedEnv,
  'TURSO_DATABASE_URL' | 'TURSO_AUTH_TOKEN' | 'MOXFIELD_SERVER_FETCH'
> & {
  /** `MOXFIELD_SERVER_FETCH`, or its platform default (see the schema). */
  MOXFIELD_SERVER_FETCH: NonNullable<ParsedEnv['MOXFIELD_SERVER_FETCH']>;
  captureAllowedOrigins: string[];
  moxfieldSiteOrigin: string;
  /** The database to open (see {@link DatabaseLocation}). */
  database: DatabaseLocation;
};

let cached: AppConfig | undefined;

/**
 * Parses configuration from an environment object. Exposed for tests. Platform defaults
 * (see `./platform`) are derived from the same object.
 */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid git-moxfield configuration: ${issues}`);
  }
  const { TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, MOXFIELD_SERVER_FETCH, ...config } = result.data;
  if (TURSO_AUTH_TOKEN !== undefined && TURSO_DATABASE_URL === undefined) {
    // Otherwise the app would silently use the local file at DATABASE_PATH.
    throw new Error(
      'Invalid git-moxfield configuration: TURSO_AUTH_TOKEN is set but TURSO_DATABASE_URL is not',
    );
  }
  if (config.GIT_MOXFIELD_E2E === true && config.NODE_ENV === 'production') {
    // The test-only endpoints mint admin sessions for anyone who asks.
    throw new Error(
      'Invalid git-moxfield configuration: GIT_MOXFIELD_E2E must not be set when NODE_ENV=production',
    );
  }
  const moxfieldSiteOrigin = new URL(config.MOXFIELD_SITE_ORIGIN).origin;
  const captureAllowedOrigins = splitList(config.CAPTURE_ALLOWED_ORIGINS ?? moxfieldSiteOrigin).map(
    (o) => new URL(o).origin,
  );
  const location = databaseLocationFromEnv(cleaned);
  const database = new DatabaseLocation(location.source, location.url, location.authToken);
  return {
    ...config,
    MOXFIELD_SERVER_FETCH: MOXFIELD_SERVER_FETCH ?? (runsOnNetlify(env) ? 'off' : 'auto'),
    moxfieldSiteOrigin,
    captureAllowedOrigins,
    database,
  };
}

export function getConfig(): AppConfig {
  cached ??= parseConfig(process.env);
  return cached;
}

/** Test hook: forget the cached configuration. */
export function resetConfigForTests(): void {
  cached = undefined;
}
