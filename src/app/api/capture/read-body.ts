/**
 * Body limits of the capture endpoints, derived from the capture codec's limits and the
 * hosting limits. The bodies are read with `../request-body`.
 */
import 'server-only';

import {
  MAX_ENCODED_CAPTURE_CHARS,
  MAX_PLAIN_CAPTURE_BYTES,
} from '@/integrations/moxfield/capture-codec-protocol';

/*
 * Two hosts bound request bodies before these routes see them:
 *
 * - Netlify (ADR 0008) rejects bodies over 6,000,000 bytes with a 500 before the app
 *   runs, and may hand a body to the function base64-encoded (4/3 larger) within that
 *   cap. The limits below therefore stay under 4,500,000 bytes, so that every body they
 *   admit gets through the platform and an oversized one meets this app's own 413 (the
 *   capture page checks payloads before sending them, so users see its message first).
 * - Self-hosted (`next start`, `next dev`): because the app has a `proxy.ts`, Next.js
 *   buffers request bodies for it and silently truncates them at `PROXY_BODY_BUFFER_LIMIT`
 *   (`src/server/proxy-body-limit.ts`), dropping the chunk that crosses it, instead of
 *   rejecting them. The route limits must stay below that buffer with room to spare, so
 *   that a truncated body still exceeds the route limit and is reported as too large,
 *   never mistaken for malformed data (`read-body.test.ts`). On Netlify the proxy runs as
 *   an edge function and this buffer does not apply.
 *
 * Bodies announced as larger than a route limit are rejected before reading.
 */

/** Room in a body for everything besides the payload: the JSON wrapper or the other form fields. */
const BODY_OVERHEAD_BYTES = 64 * 1024;

/**
 * Body limit of `POST /api/capture`: the largest payload the decoder accepts, as a JSON
 * string inside the JSON body. A compressed payload (at most
 * {@link MAX_ENCODED_CAPTURE_CHARS}) is base64url, which JSON never escapes; a plain one
 * (at most {@link MAX_PLAIN_CAPTURE_BYTES}) at most doubles, since JSON escaping at most
 * doubles valid JSON text (quotes, backslashes, newlines). 2,865,536 bytes. The decoder
 * re-checks the payload itself.
 */
export const CAPTURE_JSON_BODY_LIMIT =
  Math.max(MAX_ENCODED_CAPTURE_CHARS, 2 * MAX_PLAIN_CAPTURE_BYTES) + BODY_OVERHEAD_BYTES;

/**
 * Body limit of `POST /api/capture/form`: the largest payload the decoder accepts, form
 * encoded. Percent-encoding leaves a compressed payload's base64url as it is, except the
 * tag's `:` (`%3A`, 2 more bytes), and turns each byte of a plain one into at most three;
 * plus room for the field names and the bookmarklet key. 4,265,536 bytes.
 */
export const CAPTURE_FORM_BODY_LIMIT =
  Math.max(MAX_ENCODED_CAPTURE_CHARS + 2, 3 * MAX_PLAIN_CAPTURE_BYTES) + BODY_OVERHEAD_BYTES;
