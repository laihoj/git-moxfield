import type { NextConfig } from 'next';

import { PROXY_BODY_BUFFER_LIMIT } from './src/server/proxy-body-limit';
import { UNLOGGED_REQUEST_PATTERNS } from './src/server/request-log-filter';

/**
 * Security headers. The app renders untrusted Moxfield content (card names, primer
 * markdown) exclusively through React, so no inline HTML is ever injected; the CSP is
 * defence in depth. Card images come from Scryfall's image CDN only.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  // Next.js injects inline bootstrap scripts; 'unsafe-eval' is required by the dev server only.
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://cards.scryfall.io",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  // A separate build directory lets the e2e suite run its own `next dev` while a
  // developer's dev server is running (Next allows one dev server per directory).
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // The floating dev indicator covers the fixed mobile navigation; build and runtime
  // errors are still surfaced in development.
  devIndicators: false,
  logging: {
    // The dev server logs every request URL in full; link tokens travel in URLs and must
    // never reach a log (share, device and recovery links, invites; see the module).
    incomingRequests: { ignore: [...UNLOGGED_REQUEST_PATTERNS] },
  },
  experimental: {
    // `src/proxy.ts` makes Next buffer request bodies; captured decks are posted as JSON
    // strings inside JSON (escaping can double them) or form-encoded (up to triple), so
    // allow comfortably more than MAX_CAPTURE_BYTES. The capture routes enforce their own
    // exact limits, which stay below this one (see src/app/api/capture/read-body.ts).
    proxyClientMaxBodySize: PROXY_BODY_BUFFER_LIMIT,
  },
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      {
        // The capture page is opened by a bookmarklet on moxfield.com and must keep
        // `window.opener` so the two windows can exchange messages.
        source: '/capture',
        headers: [{ key: 'Cross-Origin-Opener-Policy', value: 'unsafe-none' }],
      },
    ]);
  },
};

export default nextConfig;
