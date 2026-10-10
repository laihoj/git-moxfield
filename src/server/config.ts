/**
 * Typed, validated server configuration from environment variables.
 * Server-only: never import from client components (it would leak nothing secret,
 * but `MOXFIELD_USER_AGENT` must stay on the server by policy).
 */
import 'server-only';

import { z } from 'zod';

import { invalidAllowedHosts } from './host-guard';

const boolish = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
  .transform((v) => ['true', '1', 'yes', 'on'].includes(v));

const schema = z.object({
  DATABASE_PATH: z.string().min(1).default('data/git-moxfield.db'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /** Base URL of the Moxfield API. Overridden in tests to point at the mock server. */
  MOXFIELD_API_BASE_URL: z.url().default('https://api2.moxfield.com'),
  /** Origin of the Moxfield website (deck URLs, capture origin check). */
  MOXFIELD_SITE_ORIGIN: z.url().default('https://moxfield.com'),
  /** User-Agent issued by Moxfield for approved projects. Server-side only. */
  MOXFIELD_USER_AGENT: z.string().trim().min(1).optional(),
  /** `auto`: try server fetches, back off when blocked. `off`: browser capture only. */
  MOXFIELD_SERVER_FETCH: z.enum(['auto', 'off']).default('auto'),
  MOXFIELD_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  /** Minimum spacing between any two requests to Moxfield from this process. */
  MOXFIELD_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(1_000),
  /** How long to pause server fetches after a bot-protection block. */
  MOXFIELD_BLOCK_BACKOFF_SECONDS: z.coerce.number().int().min(0).max(86_400).default(3_600),

  /** Minimum seconds between two refreshes of the same deck. */
  REFRESH_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3_600).default(10),
  /** Deck pages trigger a background refresh when the latest observation is older than this. */
  AUTO_REFRESH_AFTER_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),

  /** Comma-separated origins allowed to hand captured decks to /capture. Defaults to the Moxfield site origin. */
  CAPTURE_ALLOWED_ORIGINS: z.string().optional(),
  /** Public URL of this app, baked into bookmarklets. Defaults to the request origin. */
  PUBLIC_APP_URL: z.url().optional(),
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

export type AppConfig = z.infer<typeof schema> & {
  captureAllowedOrigins: string[];
  moxfieldSiteOrigin: string;
};

let cached: AppConfig | undefined;

/** Parses configuration from an environment object. Exposed for tests. */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid git-moxfield configuration: ${issues}`);
  }
  const config = result.data;
  if (config.GIT_MOXFIELD_E2E === true && config.NODE_ENV === 'production') {
    // The test-only endpoints mint admin sessions for anyone who asks.
    throw new Error(
      'Invalid git-moxfield configuration: GIT_MOXFIELD_E2E must not be set when NODE_ENV=production',
    );
  }
  const moxfieldSiteOrigin = new URL(config.MOXFIELD_SITE_ORIGIN).origin;
  const captureAllowedOrigins = (config.CAPTURE_ALLOWED_ORIGINS ?? moxfieldSiteOrigin)
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => new URL(o).origin);
  return { ...config, moxfieldSiteOrigin, captureAllowedOrigins };
}

export function getConfig(): AppConfig {
  cached ??= parseConfig(process.env);
  return cached;
}

/** Test hook: forget the cached configuration. */
export function resetConfigForTests(): void {
  cached = undefined;
}
