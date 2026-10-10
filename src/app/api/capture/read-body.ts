/**
 * Bounded request body reading for the capture endpoints. Bodies are untrusted and may
 * be large, so they are read incrementally and abandoned as soon as they exceed the
 * limit, instead of being buffered whole by `request.text()`.
 */
import 'server-only';

import { MAX_CAPTURE_BYTES } from '@/integrations/moxfield/capture-protocol';

/*
 * Because the app has a `proxy.ts`, Next.js buffers request bodies for it and silently
 * truncates them at `PROXY_BODY_BUFFER_LIMIT` (`src/server/proxy-body-limit.ts`),
 * dropping the chunk that crosses it, instead of rejecting them. The route limits below must therefore stay below that
 * buffer with room to spare, so that a truncated body still exceeds the route limit and
 * is reported as too large, never mistaken for malformed data (`read-body.test.ts`).
 * Bodies announced as larger than a route limit are rejected before reading.
 */

/**
 * Body limit of `POST /api/capture`. The envelope (at most {@link MAX_CAPTURE_BYTES})
 * arrives as a JSON string inside the JSON body, and JSON escaping at most doubles valid
 * JSON text (quotes, backslashes, newlines), so twice the limit plus room for the
 * wrapper accepts every capture the capture page accepts. The payload itself is
 * re-checked by the service.
 */
export const CAPTURE_JSON_BODY_LIMIT = 2 * MAX_CAPTURE_BYTES + 64 * 1024;

/**
 * Body limit of `POST /api/capture/form`. Form encoding expands the envelope (at most
 * {@link MAX_CAPTURE_BYTES}): percent-encoding turns each byte into at most three, plus
 * room for the field names and the capture token.
 */
export const CAPTURE_FORM_BODY_LIMIT = 3 * MAX_CAPTURE_BYTES + 64 * 1024;

export type BodyReadResult =
  { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; reason: 'too-large' | 'unreadable' };

/** Rejects early when `Content-Length` already announces a body over the limit. */
export function declaredTooLarge(headers: Headers, limit: number): boolean {
  const declared = headers.get('content-length');
  if (declared === null) return false;
  const length = Number(declared);
  return Number.isFinite(length) && length > limit;
}

/** Reads the whole body as bytes, counting while reading; gives up past `limit` bytes. */
export async function readBodyLimited(request: Request, limit: number): Promise<BodyReadResult> {
  if (request.body === null) return { ok: true, bytes: new Uint8Array() };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return { ok: false, reason: 'too-large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
