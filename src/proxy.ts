/**
 * Runs before every request except Next.js's static build assets and the PWA
 * manifest/icons, so it covers all pages, the capture endpoints and server actions:
 *
 * 1. **Host guard** (always): requests addressed to a host name git-moxfield does not
 *    answer to get 421, which defeats DNS rebinding (see `src/server/host-guard.ts`).
 *    IP literals and `localhost` are always allowed; other names must be the host of
 *    `PUBLIC_APP_URL` or be listed in `ALLOWED_HOSTS`.
 * 2. **Basic auth** (optional), for exposing git-moxfield beyond localhost. Enabled only
 *    when both `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` are set.
 *
 * Settings are read straight from the environment: the proxy runs before, and
 * independently of, the app's typed configuration.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { configuredHostnames, isAllowedRequestHost } from './server/host-guard';

const REALM = 'git-moxfield';

/** Constant-time comparison of two strings (hashed first, so lengths do not leak). */
function safeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/** Decodes `Authorization: Basic base64(user:password)`; `null` when absent or malformed. */
function basicCredentials(header: string | null): { user: string; password: string } | null {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? '');
  const encoded = match?.[1];
  if (encoded === undefined) return null;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) return null;
  return { user: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/** 421 Misdirected Request: the request names a host this app does not answer to. */
function unknownHostResponse(): NextResponse {
  return new NextResponse(
    'Unknown host. To reach git-moxfield under this name, add it to ALLOWED_HOSTS or set PUBLIC_APP_URL.\n',
    {
      status: 421,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    },
  );
}

export function proxy(request: NextRequest): NextResponse {
  const allowedHosts = configuredHostnames({
    PUBLIC_APP_URL: process.env.PUBLIC_APP_URL,
    ALLOWED_HOSTS: process.env.ALLOWED_HOSTS,
  });
  if (!isAllowedRequestHost(request.headers, allowedHosts)) return unknownHostResponse();

  const expectedUser = process.env.BASIC_AUTH_USER ?? '';
  const expectedPassword = process.env.BASIC_AUTH_PASSWORD ?? '';
  if (expectedUser === '' || expectedPassword === '') return NextResponse.next();

  const credentials = basicCredentials(request.headers.get('authorization'));
  // Evaluate both comparisons unconditionally so timing does not reveal which one failed.
  const userOk = safeEqual(credentials?.user ?? '', expectedUser);
  const passwordOk = safeEqual(credentials?.password ?? '', expectedPassword);
  if (credentials !== null && userOk && passwordOk) return NextResponse.next();

  return new NextResponse('Authentication required.\n', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export const config = {
  // Everything except Next.js's immutable build assets and the public PWA metadata
  // (browsers fetch the web app manifest and icons without credentials).
  matcher: ['/((?!_next/static|_next/image|manifest.webmanifest|icon.svg|apple-icon|icons/).*)'],
};
