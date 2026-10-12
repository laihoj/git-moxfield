/**
 * Paths of the account pages and endpoints, shared by the server (redirects, links the
 * services issue, command-line output) and the pages that implement them. The UI's
 * route builders must produce the same paths.
 *
 *   /signin               sign-in page (`?next=` = where to go afterwards)
 *   /signin/<gml_token>   one-time device or recovery link (consumed by a POST, never on GET)
 *   /signin/bookmarklet   asks before a same-tab bookmarklet signs this browser in
 *   /invite/<gmi_token>   invite (accepted by a POST, never on GET)
 *   /claim                first-run claim with the setup code
 *   /api/auth/handoff     finishes a sign-in started by a cross-site bookmarklet post
 *   /s/<gmv_token>/…      a deck shared with a read-only link (ADR 0007), and its pages
 *
 * Link tokens travel in the path. Sign-in links are one-time and short-lived; share
 * links last until revoked. The app sends `Referrer-Policy: no-referrer`, so they do not
 * leak through Referer headers, and the dev server does not log requests to these paths
 * (`../request-log-filter.ts`). Pages must never consume a link on GET: chat apps and
 * mail scanners fetch links to preview them.
 *
 * Dependency-free and pure (no secrets): the proxy uses it too.
 */

export const SIGN_IN_PATH = '/signin';
export const CLAIM_PATH = '/claim';
export const HANDOFF_PATH = '/api/auth/handoff';
/** The page that asks before a bookmarklet hand-off signs this browser in (see {@link HANDOFF_PATH}). */
export const HANDOFF_CONFIRM_PATH = '/signin/bookmarklet';

/** Longest `next` target accepted by {@link safeRedirectPath}. */
const MAX_REDIRECT_LENGTH = 2048;

/** Path of a device or recovery link (`token` is a `gml_` token). */
export function loginLinkPath(token: string): string {
  return `${SIGN_IN_PATH}/${token}`;
}

/** Prefix of invites (see {@link invitePath}). */
export const INVITE_PATH = '/invite';

/** Path of an invite (`token` is a `gmi_` token). */
export function invitePath(token: string): string {
  return `${INVITE_PATH}/${token}`;
}

/** Prefix of the pages of decks shared with a read-only link. */
export const SHARED_DECK_PATH = '/s';

/**
 * Path of a deck shared with a read-only link (`token` is a `gmv_` token); the deck's
 * pages for viewers live below it (`/s/<token>/history`, …).
 */
export function sharedDeckPath(token: string): string {
  return `${SHARED_DECK_PATH}/${token}`;
}

/** The token at the end of a link path: the inverse of {@link loginLinkPath} and the like. */
export function tokenOfLinkPath(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** `base` with `?next=` set to the local path `next` (checked with {@link safeRedirectPath}), unless that is the home page. */
function withNext(base: string, next?: string): string {
  const target = safeRedirectPath(next, '/');
  return target === '/' ? base : `${base}?next=${encodeURIComponent(target)}`;
}

/** The page that asks before a bookmarklet signs this browser in, continuing to `next` afterwards. */
export function handoffConfirmPath(next?: string): string {
  return withNext(HANDOFF_CONFIRM_PATH, next);
}

/** The hand-off route that finishes a cross-site bookmarklet sign-in, continuing to `next` afterwards. */
export function handoffPath(next: string): string {
  return withNext(HANDOFF_PATH, next);
}

/** The sign-in page, returning to `next` (a local path) afterwards. */
export function signInPath(next?: string): string {
  return withNext(SIGN_IN_PATH, next);
}

/** A base no real request uses, for resolving `next` values as the browser would. */
const REDIRECT_BASE = 'http://git-moxfield.invalid';

/**
 * Whether `path` is a path on this site as written: starts with one `/` (not `//` or
 * `/\`, which browsers resolve as protocol-relative URLs to another host) and holds no
 * control characters or backslashes.
 */
function isPlainLocalPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return false;
  return !/[\u0000-\u001f\u007f\\]/.test(path);
}

/**
 * `value` when it is a path on this site (`/decks/x?tab=deck`), otherwise `fallback`.
 * Rejects absolute and protocol-relative URLs (`https://evil`, `//evil`, `/\evil`),
 * control characters and overlong input, so a `next` parameter can never redirect to
 * another site (open redirect).
 *
 * The result is the path normalized the way the browser resolves it (dot segments,
 * also percent-encoded ones, removed), and the checks apply to that normalized path as
 * well as to the input: `/.//evil`, `/a/..//evil` and `/%2e%2e//evil` all normalize to
 * the protocol-relative `//evil` and fall back. Values whose normalization does not
 * stay a plain local path are rejected rather than repaired.
 */
export function safeRedirectPath(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REDIRECT_LENGTH) return fallback;
  if (!isPlainLocalPath(value)) return fallback;
  let url: URL;
  try {
    url = new URL(value, REDIRECT_BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== REDIRECT_BASE) return fallback;
  const path = `${url.pathname}${url.search}${url.hash}`;
  // The normalized path is what the browser follows: it must pass the same checks, and
  // resolve to itself on this origin (no further normalization quirk can change it).
  if (!isPlainLocalPath(path)) return fallback;
  const again = new URL(path, REDIRECT_BASE);
  if (again.origin !== REDIRECT_BASE || `${again.pathname}${again.search}${again.hash}` !== path) {
    return fallback;
  }
  return path;
}
