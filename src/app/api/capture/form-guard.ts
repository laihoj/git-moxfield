/**
 * Request checks of the same-tab capture endpoint (`POST /api/capture/form`), kept free
 * of I/O so they can be tested directly.
 *
 * The endpoint receives a cross-site form post from the Moxfield deck page, so it needs
 * its own CSRF protection, and the `Origin` header cannot provide it: from
 * https://moxfield.com to an http:// git-moxfield, browsers send `Origin: null` (under
 * the default referrer policy, the origin of a non-CORS request is hidden on an
 * https → http downgrade), and any site can produce `Origin: null` as well (a
 * `no-referrer` policy, a sandboxed frame). The real protection is the installation's
 * capture token, a secret that only the user's own bookmarklet carries.
 */
import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';

import { CAPTURE_TOKEN_PATTERN } from '@/integrations/moxfield/capture-protocol';

/** The opaque origin as serialized in an `Origin` header. */
const OPAQUE_ORIGIN = 'null';

/**
 * Whether a same-tab capture may come from `origin`, the request's `Origin` header.
 *
 * Accepted: one of the configured capture origins (Moxfield, e.g. when git-moxfield is
 * served over https), the opaque origin `null` (Moxfield → http:// git-moxfield) and a
 * missing header (browsers that omit it). Any other explicit origin is a third-party
 * site and is rejected. This is defence in depth only; see {@link isValidCaptureToken}.
 */
export function isAcceptableCaptureOrigin(origin: string | null, allowedOrigins: readonly string[]): boolean {
  return origin === null || origin === OPAQUE_ORIGIN || allowedOrigins.includes(origin);
}

/**
 * Whether `candidate` (the posted token field; anything a form can hold, or nothing) is
 * this installation's capture token `expected`. Constant-time: both sides are reduced
 * to fixed-length SHA-256 digests before the comparison, so neither the content nor the
 * length of the token leaks through timing. A malformed `expected` token (which no
 * bookmarklet can carry) never matches, so an empty or broken setting fails closed.
 */
export function isValidCaptureToken(candidate: unknown, expected: string): boolean {
  if (!CAPTURE_TOKEN_PATTERN.test(expected)) return false;
  if (typeof candidate !== 'string') return false;
  return timingSafeEqual(sha256(candidate), sha256(expected));
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}
