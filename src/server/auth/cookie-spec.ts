/**
 * The cookies git-moxfield sets (ADR 0006), as plain data and `Set-Cookie` values, plus
 * reading them back from a `Cookie` header. Free of Next.js request APIs, configuration
 * and the database, so the proxy (`src/proxy.ts`), route handlers and server actions
 * share one definition (`./cookies` adds the Next.js glue).
 *
 * - **Session cookie**: the session token. `HttpOnly` (no script can read it),
 *   `SameSite=Lax` (not sent with cross-site POSTs, which with Next.js's server-action
 *   origin check and the endpoints' same-origin checks rules out CSRF), `Path=/`, `Secure`
 *   whenever the browser accepts it. Its `Max-Age` follows the session's sliding expiry:
 *   set at sign-in, and refreshed by the proxy as the browser keeps using it
 *   (`./session-refresh`).
 * - **Hand-off cookie**: the pending hand-off of the same-tab bookmarklet (five minutes,
 *   see `src/app/api/auth/handoff`). It signs nobody in by itself.
 * - **Freshness marker**: tells the proxy that the session cookie's `Max-Age` was set
 *   within the last day, so it is refreshed at most daily. Holds no secret.
 *
 * **Names.** In a secure context (https, or the loopback host where browsers accept
 * `Secure` cookies over http) every name carries the `__Host-` prefix. Browsers accept
 * such a cookie only with `Secure`, `Path=/` and no `Domain`, so no other host, such as
 * a sibling subdomain of a shared domain, can plant or overwrite it ("cookie tossing").
 * Plain http to any other host (a LAN address) cannot carry `Secure`, so the names are
 * unprefixed there. The two sets are never read across: in a secure context an
 * unprefixed cookie, which anyone on the same site could have set, is ignored.
 *
 * **Duplicates.** A request that carries one of these cookies more than once (one of them
 * planted for a parent domain, possible only with unprefixed names) is ambiguous:
 * {@link readCookie} treats the cookie as absent instead of guessing.
 *
 * Values are tokens (base64url), safe in a cookie as they are. They never appear
 * anywhere else: not in URLs, logs or HTML.
 */
import { isLoopbackHostname } from '@/lib/hosts';
import { firstHeaderValue, forwardedHost, hostnameOf, type HeaderSource } from '@/server/host-guard';

const DAY_S = 24 * 60 * 60;

/** Session cookie lifetime: 400 days, the longest `Max-Age` browsers keep. */
export const SESSION_MAX_AGE_S = 400 * DAY_S;

/** The proxy refreshes the session cookie at most this often (the freshness marker's lifetime). */
export const SESSION_REFRESH_INTERVAL_S = DAY_S;

/** Everything about a cookie this app sets. */
export interface CookieSpec {
  name: string;
  value: string;
  /** Always `/`: `__Host-` cookies require it. */
  path: '/';
  /** Seconds until the browser drops the cookie; `0` deletes it. */
  maxAge: number;
  secure: boolean;
  httpOnly: true;
  sameSite: 'lax';
}

/** The names of this app's cookies in a secure or plain context (see the module comment). */
export interface CookieNames {
  session: string;
  handoff: string;
  fresh: string;
}

const PLAIN_NAMES: CookieNames = { session: 'gm_session', handoff: 'gm_handoff', fresh: 'gm_session_fresh' };
const SECURE_NAMES: CookieNames = {
  session: '__Host-gm_session',
  handoff: '__Host-gm_handoff',
  fresh: '__Host-gm_session_fresh',
};

/** The cookie names for a request whose cookies are (`secure`) or are not `Secure`. */
export function cookieNames(secure: boolean): CookieNames {
  return secure ? SECURE_NAMES : PLAIN_NAMES;
}

/**
 * Whether cookies set in answer to a request get `Secure` (and the `__Host-` names): when
 * the request came over https (`X-Forwarded-Proto`, which Next.js fills in from the
 * connection when no proxy sets it), when `PUBLIC_APP_URL` is an https URL, or when the
 * request is addressed to the loopback host (`localhost`, `*.localhost`, `127.0.0.1`,
 * `[::1]`), where browsers accept `Secure` cookies over plain http. Plain http to any
 * other host (a LAN address) cannot carry `Secure` cookies, so they are set without it.
 */
export function isSecureCookieContext(
  requestHeaders: HeaderSource,
  publicAppUrl: string | undefined,
): boolean {
  if (firstHeaderValue(requestHeaders.get('x-forwarded-proto')) === 'https') return true;
  if (publicAppUrl?.toLowerCase().startsWith('https:') === true) return true;
  const host = forwardedHost(requestHeaders);
  const hostname = host === null ? null : hostnameOf(host);
  return hostname !== null && isLoopbackHostname(hostname);
}

/** The session cookie for `session`, expiring with it (`Max-Age` = its remaining lifetime). */
export function sessionCookie(
  session: { token: string; expiresAt: string },
  now: Date,
  secure: boolean,
): CookieSpec {
  return cookie(cookieNames(secure).session, session.token, remainingSeconds(session.expiresAt, now), secure);
}

/** The session cookie with the full {@link SESSION_MAX_AGE_S}, as the proxy refreshes it. */
export function refreshedSessionCookie(token: string, secure: boolean): CookieSpec {
  return cookie(cookieNames(secure).session, token, SESSION_MAX_AGE_S, secure);
}

/** Deletes the session cookie. */
export function expiredSessionCookie(secure: boolean): CookieSpec {
  return cookie(cookieNames(secure).session, '', 0, secure);
}

/** The hand-off cookie of a pending hand-off, expiring with it. */
export function handoffCookie(
  handoff: { token: string; expiresAt: string },
  now: Date,
  secure: boolean,
): CookieSpec {
  return cookie(cookieNames(secure).handoff, handoff.token, remainingSeconds(handoff.expiresAt, now), secure);
}

/** Deletes the hand-off cookie. */
export function expiredHandoffCookie(secure: boolean): CookieSpec {
  return cookie(cookieNames(secure).handoff, '', 0, secure);
}

/** The cookies that make `session` a browser's session: the session cookie and the freshness marker. */
export function establishedSessionCookies(
  session: { token: string; expiresAt: string },
  now: Date,
  secure: boolean,
): CookieSpec[] {
  return [sessionCookie(session, now, secure), freshMarkerCookie(secure)];
}

/** The freshness marker: the session cookie was (re)set just now. */
export function freshMarkerCookie(secure: boolean): CookieSpec {
  return cookie(cookieNames(secure).fresh, '1', SESSION_REFRESH_INTERVAL_S, secure);
}

/** Deletes the freshness marker. */
export function expiredFreshMarkerCookie(secure: boolean): CookieSpec {
  return cookie(cookieNames(secure).fresh, '', 0, secure);
}

/** The `Set-Cookie` header value of a cookie. */
export function serializeCookie(spec: CookieSpec): string {
  const parts = [
    `${spec.name}=${spec.value}`,
    `Path=${spec.path}`,
    `Max-Age=${spec.maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (spec.maxAge === 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  if (spec.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * The value of cookie `name` in a `Cookie` request header, or `null` when the cookie is
 * absent, or present more than once (ambiguous: one of them may have been planted for a
 * parent domain, and browsers do not say which is which).
 */
export function readCookie(cookieHeader: string | null, name: string): string | null {
  const values = cookieValues(cookieHeader, name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

/** Whether a `Cookie` request header carries cookie `name` more than once (see {@link readCookie}). */
export function isCookieAmbiguous(cookieHeader: string | null, name: string): boolean {
  return cookieValues(cookieHeader, name).length > 1;
}

/** Every value of cookie `name` in a `Cookie` header, in order. */
function cookieValues(cookieHeader: string | null, name: string): string[] {
  if (cookieHeader === null) return [];
  const values: string[] = [];
  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=');
    if (separator !== -1 && pair.slice(0, separator).trim() === name) {
      values.push(pair.slice(separator + 1).trim());
    }
  }
  return values;
}

function cookie(name: string, value: string, maxAge: number, secure: boolean): CookieSpec {
  return { name, value, path: '/', maxAge, secure, httpOnly: true, sameSite: 'lax' };
}

/** Whole seconds from `now` until `expiresAt` (at least 0). */
function remainingSeconds(expiresAt: string, now: Date): number {
  const ms = Date.parse(expiresAt) - now.getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
}
