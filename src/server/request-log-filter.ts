/**
 * Which incoming requests the Next.js dev server leaves out of its request log
 * (`logging.incomingRequests` in `next.config.ts`).
 *
 * The dev server (`pnpm dev`, `pnpm dev:lan`, `pnpm dev:mock`) prints the path and query
 * of every request in full, and link tokens travel in paths (ADR 0006, ADR 0007). They
 * are bearer secrets: a share link opens a deck's history until it is revoked, a device
 * or recovery link signs someone in. So no request to a page that carries one is
 * logged, whatever follows in the path or query (`?_rsc` navigations and prefetches, the
 * `restore.txt` download and form posts included): `/s/<gmv_…>/…`, `/signin/<gml_…>` and
 * `/invite/<gmi_…>`. They are matched by route rather than by token prefix, so a
 * mangled or cut-off token stays out of the log too; and a URL holding anything shaped
 * like one of the app's tokens is never logged, wherever the token sits.
 *
 * Production servers (`next start`) log no requests. Deliberately dependency-free and
 * not `server-only`: `next.config.ts` imports it.
 */
import { HANDOFF_CONFIRM_PATH, INVITE_PATH, SHARED_DECK_PATH, SIGN_IN_PATH } from './auth/paths';
import { TOKEN_PREFIXES } from '../core/token-format';

/** `value` as a literal in a regular expression. */
function literal(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** An optional `scheme://host` before the path, for a request target in absolute form. */
const ORIGIN = '(?:[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*)?';

/** The pages below `/signin/` that carry no token: the bookmarklet sign-in confirmation. */
const SIGN_IN_PAGES = literal(HANDOFF_CONFIRM_PATH.slice(`${SIGN_IN_PATH}/`.length));

/**
 * Patterns of the request URLs (path and query, as the dev server logs them) that must
 * never be logged; see the module comment.
 */
export const UNLOGGED_REQUEST_PATTERNS: readonly RegExp[] = [
  // A share link and every page, navigation and download below it.
  new RegExp(`^${ORIGIN}${literal(SHARED_DECK_PATH)}/`),
  // A device or recovery link: anything below /signin/ but the bookmarklet confirmation.
  new RegExp(`^${ORIGIN}${literal(SIGN_IN_PATH)}/(?!${SIGN_IN_PAGES}(?:[/?#]|$))`),
  new RegExp(`^${ORIGIN}${literal(INVITE_PATH)}/`),
  // Anything shaped like one of the app's tokens, anywhere (also inside a query value).
  new RegExp(`(?:${Object.values(TOKEN_PREFIXES).map(literal).join('|')})[A-Za-z0-9_-]`),
];

/** Whether a request for `url` (path and query) must stay out of the request log. */
export function isUnloggedRequest(url: string): boolean {
  return UNLOGGED_REQUEST_PATTERNS.some((pattern) => pattern.test(url));
}
