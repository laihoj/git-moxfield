/**
 * The session and hand-off cookies (ADR 0006) in route handlers, server actions and
 * server components. What the cookies are (names, attributes, the `__Host-` prefix,
 * duplicate handling) is defined in `./cookie-spec`; this module reads and sets them
 * with the request's security context.
 *
 * Cookies can only be set in server actions and route handlers (never while rendering a
 * page), hence two sets of helpers: `…OnResponse` / `readRequest…` for route handlers
 * (plain `Response`s) and the `next/headers` ones for server actions and pages.
 *
 * Setting a session replaces the browser's previous one, so {@link establishSession} and
 * {@link establishSessionOnResponse} also end the replaced session: no browser can hold
 * its token any more, and it would otherwise linger in the user's device list. A cookie
 * the request carries twice is ambiguous and read as absent, so no session is ended on
 * the strength of a cookie another site may have planted.
 */
import 'server-only';

import { cookies, headers } from 'next/headers';
import type { NextRequest } from 'next/server';

import { getConfig } from '@/server/config';
import type { HeaderSource } from '@/server/host-guard';

import {
  cookieNames,
  establishedSessionCookies,
  expiredFreshMarkerCookie,
  expiredSessionCookie,
  isCookieAmbiguous,
  isSecureCookieContext,
  readCookie,
  serializeCookie,
  type CookieSpec,
} from './cookie-spec';
import { getAuthService } from './index';
import type { IssuedSession } from './types';

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** Whether cookies set in answer to a request with these headers are `Secure` and `__Host-` (see `isSecureCookieContext`). */
function cookieSecurity(requestHeaders: HeaderSource): boolean {
  return isSecureCookieContext(requestHeaders, getConfig().PUBLIC_APP_URL);
}

/** Whether cookies set in answer to `request` are `Secure` and `__Host-` (see `isSecureCookieContext`). */
export function requestCookieSecurity(request: NextRequest): boolean {
  return cookieSecurity(request.headers);
}

/** The session token cookie of the request (`null` when absent or ambiguous). */
export function readRequestSessionToken(request: NextRequest): string | null {
  return readCookie(request.headers.get('cookie'), cookieNames(requestCookieSecurity(request)).session);
}

/** The hand-off token cookie of the request (`null` when absent or ambiguous). */
export function readRequestHandoffToken(request: NextRequest): string | null {
  return readCookie(request.headers.get('cookie'), cookieNames(requestCookieSecurity(request)).handoff);
}

/** Adds a `Set-Cookie` header to a route handler's response (which must have mutable headers). */
export function appendCookie(response: Response, spec: CookieSpec): Response {
  response.headers.append('set-cookie', serializeCookie(spec));
  return response;
}

/**
 * Makes `session` the browser's session in a route handler's response: sets the cookie
 * (and the proxy's freshness marker, as it was set just now), and ends the session the
 * request's cookie held if it was another one.
 */
export async function establishSessionOnResponse(
  request: NextRequest,
  response: Response,
  session: IssuedSession,
): Promise<Response> {
  await endReplacedSession(readRequestSessionToken(request), session.token);
  for (const spec of establishedSessionCookies(session, new Date(), requestCookieSecurity(request))) {
    appendCookie(response, spec);
  }
  return response;
}

// ---------------------------------------------------------------------------
// Server actions (and reading in server components)
// ---------------------------------------------------------------------------

/** The session token cookie of the current request (`null` when absent or ambiguous). */
export async function readSessionToken(): Promise<string | null> {
  return readContextCookie('session');
}

/** The hand-off token cookie of the current request (`null` when absent or ambiguous). */
export async function readHandoffToken(): Promise<string | null> {
  return readContextCookie('handoff');
}

/**
 * A cookie of the current request: `null` when the request carried it more than once
 * (checked on the raw header, which Next.js's parser collapses), else its value as
 * `cookies()` sees it, which includes what a server action set or deleted before the
 * page renders again.
 */
async function readContextCookie(which: 'session' | 'handoff'): Promise<string | null> {
  const requestHeaders = await headers();
  const name = cookieNames(cookieSecurity(requestHeaders))[which];
  if (isCookieAmbiguous(requestHeaders.get('cookie'), name)) return null;
  return (await cookies()).get(name)?.value ?? null;
}

/**
 * Makes `session` this browser's session (call from a server action only): sets the
 * session cookie, and ends the session the cookie held before if it was another one.
 */
export async function establishSession(session: IssuedSession): Promise<void> {
  await endReplacedSession(await readSessionToken(), session.token);
  const secure = cookieSecurity(await headers());
  const store = await cookies();
  for (const spec of establishedSessionCookies(session, new Date(), secure)) store.set(spec);
}

/** Signs this browser out (call from a server action only): ends its session and deletes the cookie. */
export async function endBrowserSession(): Promise<void> {
  await endSessionToken(await readSessionToken());
  const secure = cookieSecurity(await headers());
  const store = await cookies();
  store.set(expiredSessionCookie(secure));
  store.set(expiredFreshMarkerCookie(secure));
}

/** Ends the session the browser held before, when `next` replaces it with another one. */
async function endReplacedSession(previous: string | null, next: string): Promise<void> {
  if (previous !== null && previous !== next) await endSessionToken(previous);
}

/** Ends the session of a session cookie value (a no-op for `null`). */
async function endSessionToken(token: string | null): Promise<void> {
  if (token === null) return;
  const auth = await getAuthService();
  await auth.endSession(token);
}
