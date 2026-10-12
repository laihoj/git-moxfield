/**
 * The end-to-end suite's test-only endpoints (`/api/e2e/*`) exist only in development and
 * test builds with `GIT_MOXFIELD_E2E=true` (set by `playwright.config.ts`); otherwise they
 * answer 404, as if they did not exist. They mint sessions (admins included) for anyone
 * who asks, so three layers keep them out of a real installation:
 *
 * - production builds: `next build` inlines `process.env.NODE_ENV`, so in its output the
 *   check below is constant and the handlers can never get past it, whatever the
 *   configuration says;
 * - configuration: `parseConfig` refuses `GIT_MOXFIELD_E2E` with `NODE_ENV=production`,
 *   so a misconfigured server fails at once instead of serving them;
 * - visibility: the first request to an enabled endpoint logs a warning.
 */
import 'server-only';

import { getConfig } from '@/server/config';
import { plainText } from '@/server/http/responses';
import { createLogger } from '@/server/logger';

const globalForE2e = globalThis as unknown as { __gitMoxfieldE2eAnnounced?: boolean };

function notFound(): Response {
  return plainText(404, 'Not found.');
}

/** `null` when the e2e endpoints are enabled, else the 404 to answer with. */
export function e2eDisabledResponse(): Response | null {
  // First, before any configuration is read: compiled away in production builds.
  if (process.env.NODE_ENV === 'production') return notFound();
  if (getConfig().GIT_MOXFIELD_E2E !== true) return notFound();
  if (globalForE2e.__gitMoxfieldE2eAnnounced !== true) {
    globalForE2e.__gitMoxfieldE2eAnnounced = true;
    createLogger('api/e2e').warn(
      'The end-to-end test endpoints (/api/e2e/*) are enabled: they sign anyone in. Never set GIT_MOXFIELD_E2E outside the test suite.',
    );
  }
  return null;
}
