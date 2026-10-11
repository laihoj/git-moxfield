/**
 * Capture payloads on git-moxfield's own pages (ADR 0008): compressing what the capture
 * page and the paste form send, and reading compressed text pasted into the paste form
 * (the bookmarklet copies its payload to the clipboard when its popup is blocked).
 *
 * The wire format and its limits are specified in
 * `@/integrations/moxfield/capture-codec-protocol`. Everything here is a convenience for
 * the user (early, specific messages, previews); the server's decoder stays authoritative.
 * Browser-safe: Web APIs only.
 */
import { readStreamLimited } from '@/core/streams';
import {
  base64UrlToBytes,
  decodeUtf8Strict,
  encodeCapturePayload,
  exceedsCapturePayloadLimit,
  isEncodedCapturePayload,
  MAX_DECODED_CAPTURE_BYTES,
  MAX_ENCODED_CAPTURE_CHARS,
  MAX_PLAIN_CAPTURE_BYTES,
  parseCapturePayload,
  type CapturePayloadFailure,
} from '@/integrations/moxfield/capture-codec-protocol';
import { formatBytes } from '@/lib/format';

/** The deck data is over the limit of what git-moxfield accepts at all. */
export const CAPTURE_TOO_LARGE_MESSAGE = `The deck data is too large to import (limit ${formatBytes(MAX_DECODED_CAPTURE_BYTES)}).`;

/** The deck data compresses too poorly to fit the limit of a compressed payload. */
export const CAPTURE_TOO_LARGE_COMPRESSED_MESSAGE = `The deck data is too large to import, even compressed (limit ${formatBytes(MAX_ENCODED_CAPTURE_CHARS)} compressed).`;

/** The browser cannot compress, and the deck data is over the limit of a plain payload. */
export const CAPTURE_TOO_LARGE_UNCOMPRESSED_MESSAGE = `The deck data is too large to send uncompressed (limit ${formatBytes(MAX_PLAIN_CAPTURE_BYTES)}), and this browser cannot compress it. Use a current version of Chrome, Edge, Firefox or Safari.`;

export type PreparedCapturePayload = { ok: true; payload: string } | { ok: false; message: string };

/**
 * Turns capture text into the payload to send to `POST /api/capture`: a payload that is
 * already compressed (the bookmarklet's) is sent as it is; plain JSON (a paste, or the
 * payload of a bookmarklet made before compression) is compressed first, or sent plain
 * when the browser cannot compress. Refuses, with a user-facing message, a payload the
 * server would reject as too large, so that the user sees why without a request (and
 * without the hosting platform's own error page for bodies over its limit).
 */
export async function prepareCapturePayload(text: string): Promise<PreparedCapturePayload> {
  if (isEncodedCapturePayload(text)) {
    return exceedsCapturePayloadLimit(text)
      ? { ok: false, message: CAPTURE_TOO_LARGE_COMPRESSED_MESSAGE }
      : { ok: true, payload: text };
  }
  // UTF-16 code units: a lower bound of the UTF-8 size the server measures.
  if (text.length > MAX_DECODED_CAPTURE_BYTES) return { ok: false, message: CAPTURE_TOO_LARGE_MESSAGE };

  let payload: string;
  try {
    payload = await encodeCapturePayload(text);
  } catch {
    // Compression is an optimization: the server accepts plain payloads too.
    payload = text;
  }
  if (!exceedsCapturePayloadLimit(payload)) return { ok: true, payload };
  return {
    ok: false,
    message: isEncodedCapturePayload(payload)
      ? CAPTURE_TOO_LARGE_COMPRESSED_MESSAGE
      : CAPTURE_TOO_LARGE_UNCOMPRESSED_MESSAGE,
  };
}

/**
 * Why {@link inflateCapturePayload} could not return the JSON text: a failure of the wire
 * format (too large, damaged or cut off, e.g. by copying, or an encoding this version does
 * not know), or that this browser has no `DecompressionStream`.
 */
export type InflateFailure = CapturePayloadFailure | 'unavailable';

export type InflatedCapturePayload = { ok: true; text: string } | { ok: false; reason: InflateFailure };

/**
 * Inflates gzip through `decompression`, giving up as soon as the output exceeds
 * `maxBytes`: `null` then.
 */
async function gunzip(
  bytes: Uint8Array<ArrayBuffer>,
  decompression: DecompressionStream,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return readStreamLimited(input.pipeThrough(decompression), maxBytes);
}

/**
 * Returns the JSON text of a capture payload as pasted: plain text unchanged, compressed
 * text (`gm-gzip-base64url:…`, surrounding whitespace ignored) inflated, within the
 * limits the server applies (at most {@link MAX_ENCODED_CAPTURE_CHARS} characters
 * compressed, inflating stops past `maxBytes`). For previews only: what is sent is
 * compressed again by {@link prepareCapturePayload}.
 */
export async function inflateCapturePayload(
  payload: string,
  maxBytes: number = MAX_DECODED_CAPTURE_BYTES,
): Promise<InflatedCapturePayload> {
  const parsed = parseCapturePayload(payload, MAX_ENCODED_CAPTURE_CHARS);
  if (parsed.kind === 'plain') return { ok: true, text: payload };
  if (parsed.kind === 'rejected') return { ok: false, reason: parsed.reason };
  const Decompression = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (Decompression === undefined) return { ok: false, reason: 'unavailable' };

  const compressed = base64UrlToBytes(parsed.data);
  if (compressed === null) return { ok: false, reason: 'malformed' };
  let inflated: Uint8Array | null;
  try {
    inflated = await gunzip(compressed, new Decompression('gzip'), maxBytes);
  } catch {
    // The stream errors on a bad header, checksum or length, and on truncated data.
    return { ok: false, reason: 'malformed' };
  }
  if (inflated === null) return { ok: false, reason: 'too-large' };
  const decoded = decodeUtf8Strict(inflated);
  return decoded === null ? { ok: false, reason: 'malformed' } : { ok: true, text: decoded };
}
