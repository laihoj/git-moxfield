/**
 * Request checks of the same-tab capture endpoint (`POST /api/capture/form`), kept free
 * of I/O so they can be tested directly.
 *
 * The endpoint receives a cross-site form post from the Moxfield deck page, and the
 * `Origin` header cannot tell that post from a forged one: from https://moxfield.com to
 * an http:// git-moxfield, browsers send `Origin: null` (under the default referrer
 * policy, the origin of a non-CORS request is hidden on an https → http downgrade), and
 * any site can produce `Origin: null` as well (a `no-referrer` policy, a sandboxed
 * frame). The bookmarklet key authenticates which workspace receives the capture, but
 * it is no CSRF protection either: any member can post their own key from any site. So
 * nothing this endpoint does on the strength of the post may affect anyone but the key's
 * owner; signing the browser in waits for a same-origin confirmation (see the route).
 */
import 'server-only';

import { BOOKMARKLET_KEY_PATTERN } from '@/integrations/moxfield/capture-protocol';

/** The opaque origin as serialized in an `Origin` header. */
const OPAQUE_ORIGIN = 'null';

/**
 * Whether a same-tab capture may come from `origin`, the request's `Origin` header.
 *
 * Accepted: one of the configured capture origins (Moxfield, e.g. when git-moxfield is
 * served over https), the opaque origin `null` (Moxfield → http:// git-moxfield) and a
 * missing header (browsers that omit it). Any other explicit origin is a third-party
 * site and is rejected. This is defence in depth only; the bookmarklet key authenticates
 * whose workspace receives the deck.
 */
export function isAcceptableCaptureOrigin(origin: string | null, allowedOrigins: readonly string[]): boolean {
  return origin === null || origin === OPAQUE_ORIGIN || allowedOrigins.includes(origin);
}

/**
 * Why a posted key field was not accepted, for the log: never the value itself, only
 * whether it was absent, not shaped like a bookmarklet key (e.g. the capture token of a
 * bookmarklet made before accounts), or a well-formed key that is unknown or revoked.
 */
export function describeRejectedKey(value: unknown): 'missing' | 'malformed' | 'unknown' {
  if (value === null || value === undefined) return 'missing';
  if (typeof value !== 'string' || !BOOKMARKLET_KEY_PATTERN.test(value)) return 'malformed';
  return 'unknown';
}
