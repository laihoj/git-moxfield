/**
 * Runs before every request except Next.js's static build assets and the PWA
 * manifest/icons, so it covers all pages, the capture endpoints and server actions.
 *
 * **Host guard**: requests addressed to a host name git-moxfield does not answer to get
 * 421, which defeats DNS rebinding (see `src/server/host-guard.ts`). IP literals and
 * `localhost` are always allowed; other names must be the host of `PUBLIC_APP_URL` or be
 * listed in `ALLOWED_HOSTS`.
 *
 * **Session cookie refresh**: page views re-set the session cookie with its full
 * lifetime at most once a day, so a browser in use keeps its sliding 400-day session
 * (see `src/server/auth/session-refresh.ts`). Pages cannot set cookies themselves.
 *
 * Authentication is not done here: accounts (ADR 0006) are resolved from the session
 * cookie where data is accessed (`src/server/auth`, `src/server/access`), on every
 * request and server action.
 *
 * Settings are read straight from the environment: the proxy runs before, and
 * independently of, the app's typed configuration.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { isSecureCookieContext, serializeCookie } from './server/auth/cookie-spec';
import { sessionRefreshCookies } from './server/auth/session-refresh';
import { configuredHostnames, isAllowedRequestHost } from './server/host-guard';
import { plainText } from './server/http/responses';

/** 421 Misdirected Request: the request names a host this app does not answer to. */
function unknownHostResponse(): Response {
  return plainText(
    421,
    'Unknown host. To reach git-moxfield under this name, add it to ALLOWED_HOSTS or set PUBLIC_APP_URL.',
  );
}

export function proxy(request: NextRequest): NextResponse | Response {
  const allowedHosts = configuredHostnames({
    PUBLIC_APP_URL: process.env.PUBLIC_APP_URL,
    ALLOWED_HOSTS: process.env.ALLOWED_HOSTS,
  });
  if (!isAllowedRequestHost(request.headers, allowedHosts)) return unknownHostResponse();
  const response = NextResponse.next();
  const secure = isSecureCookieContext(request.headers, process.env.PUBLIC_APP_URL);
  const refresh = sessionRefreshCookies(
    { method: request.method, pathname: request.nextUrl.pathname, headers: request.headers },
    secure,
  );
  for (const cookie of refresh) response.headers.append('set-cookie', serializeCookie(cookie));
  return response;
}

export const config = {
  // Everything except Next.js's immutable build assets and the public PWA metadata
  // (browsers fetch the web app manifest and icons without credentials).
  matcher: ['/((?!_next/static|_next/image|manifest.webmanifest|icon.svg|apple-icon|icons/).*)'],
};
