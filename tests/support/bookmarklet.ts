/**
 * Reading the bookmarklets the app builds (`javascript:` URLs). Free of test-runner
 * imports, so the Playwright e2e support can share it with the Vitest tests.
 */

/** The JavaScript source of a `javascript:` bookmarklet URL. */
export function bookmarkletSource(bookmarklet: string): string {
  const prefix = 'javascript:';
  if (!bookmarklet.startsWith(prefix)) {
    throw new Error(`Not a bookmarklet: ${bookmarklet.slice(0, 40)}…`);
  }
  return decodeURIComponent(bookmarklet.slice(prefix.length));
}

/** The personal key (`gmk_…`) a bookmarklet carries. */
export function bookmarkletKey(bookmarklet: string): string {
  const match = /"key":"(gmk_[A-Za-z0-9_-]{43})"/.exec(bookmarkletSource(bookmarklet));
  if (match?.[1] === undefined) throw new Error('No key in the bookmarklet');
  return match[1];
}
