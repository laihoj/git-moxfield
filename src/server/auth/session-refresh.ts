/**
 * Keeps the session cookie's lifetime sliding with the session (ADR 0006: "sliding
 * expiry up to 400 days").
 *
 * The auth service slides a session's expiry in the database whenever it is used, but
 * the browser drops the cookie when the `Max-Age` it got at sign-in runs out. Pages
 * cannot set cookies while rendering, so the proxy, which runs before every page view,
 * re-sets the session cookie with the full {@link SESSION_MAX_AGE_S}, at most once a day
 * per browser (a freshness marker cookie remembers the last time).
 *
 * No database lookup: the database expiry stays authoritative, so re-setting a revoked
 * or expired token resolves to nobody as before. The refresh only happens on `GET` and
 * `HEAD` requests other than the hand-off route: server actions (POSTs) and the
 * hand-off route set or delete the session cookie themselves, and a refresh in the same
 * response could put back the token a sign-out just deleted or a sign-in just replaced.
 *
 * Dependency-free (no Next.js request APIs, configuration or database), for the proxy.
 */
import {
  cookieNames,
  freshMarkerCookie,
  readCookie,
  refreshedSessionCookie,
  type CookieSpec,
} from './cookie-spec';
import { parseToken } from '@/core/token-format';
import type { HeaderSource } from '@/server/host-guard';

import { HANDOFF_PATH } from './paths';

export { SESSION_MAX_AGE_S } from './cookie-spec';

export interface RefreshableRequest {
  method: string;
  /** The request path, without the query string. */
  pathname: string;
  headers: HeaderSource;
}

/**
 * The cookies to add to the response to `request`: the session cookie with a renewed
 * `Max-Age`, and the freshness marker; or none when no refresh is due (see the module
 * comment for when). `secure`: whether the request's cookies are `Secure`
 * (`isSecureCookieContext`).
 */
export function sessionRefreshCookies(request: RefreshableRequest, secure: boolean): CookieSpec[] {
  if (request.method !== 'GET' && request.method !== 'HEAD') return [];
  if (request.pathname === HANDOFF_PATH) return [];
  const names = cookieNames(secure);
  const cookieHeader = request.headers.get('cookie');
  if (readCookie(cookieHeader, names.fresh) !== null) return [];
  const token = parseToken('session', readCookie(cookieHeader, names.session));
  if (token === null) return [];
  return [refreshedSessionCookie(token, secure), freshMarkerCookie(secure)];
}
