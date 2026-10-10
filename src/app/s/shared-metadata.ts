import type { Metadata } from 'next';

/**
 * Metadata of every share link page, found or not: never indexed, archived or followed
 * by search engines (the URL holds a bearer secret, and a deck is shared with people, not
 * the web), and no referrer when leaving (`Referrer-Policy: no-referrer` is also sent
 * for every response; this keeps it if a proxy drops that header). The pages are
 * rendered per request (`dynamic = 'force-dynamic'`), which Next.js sends as
 * `Cache-Control: private, no-cache, no-store`.
 */
export const SHARED_PAGE_METADATA = {
  robots: { index: false, follow: false, noarchive: true, nosnippet: true, noimageindex: true },
  referrer: 'no-referrer',
} satisfies Metadata;
