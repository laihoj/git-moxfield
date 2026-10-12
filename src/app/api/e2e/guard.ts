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
import { jsonResponse, plainText } from '@/server/http/responses';
import { createLogger } from '@/server/logger';

import { isCrossOriginBrowserRequest } from '../../request-origin';

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

/** The media type of a `Content-Type` value, lower-cased, without parameters. */
function mediaType(contentType: string | null): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * `null` for a request the suite itself sends (JSON from Node's fetch, which sends no
 * `Origin`), else the 415 or 403 to answer with. Defence in depth for the endpoints that
 * change something: a web page cannot send one of these, only forms and "simple" requests.
 */
export function e2eRequestRefusal(request: Request): Response | null {
  if (mediaType(request.headers.get('content-type')) !== 'application/json') {
    return jsonResponse({ error: 'Send application/json.' }, { status: 415 });
  }
  if (isCrossOriginBrowserRequest(request)) {
    return jsonResponse({ error: 'Cross-origin requests are refused.' }, { status: 403 });
  }
  return null;
}
