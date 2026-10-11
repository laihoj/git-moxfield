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
  CAPTURE_GZIP_TAG,
  encodeCapturePayload,
  exceedsCapturePayloadLimit,
  isEncodedCapturePayload,
  MAX_DECODED_CAPTURE_BYTES,
  MAX_ENCODED_CAPTURE_CHARS,
  MAX_PLAIN_CAPTURE_BYTES,
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

/** Why {@link inflateCapturePayload} could not return the JSON text. */
export type InflateFailure =
  /** Over the limits of a compressed payload, compressed or inflated. */
  | 'too-large'
  /** Not valid base64url, gzip or UTF-8: damaged or cut off, e.g. by copying. */
  | 'malformed'
  /** Tagged with an encoding this version does not know. */
  | 'unsupported-encoding'
  /** This browser has no `DecompressionStream`. */
  | 'unavailable';

export type InflatedCapturePayload = { ok: true; text: string } | { ok: false; reason: InflateFailure };

/** The base64url alphabet (RFC 4648 §5), without padding. */
const BASE64URL = /^[A-Za-z0-9_-]*$/;

function base64UrlToBytes(data: string): Uint8Array<ArrayBuffer> | null {
  // A single character in the last group carries no whole byte: never valid.
  if (!BASE64URL.test(data) || data.length % 4 === 1) return null;
  let binary: string;
  try {
    // `atob` accepts unpadded input (forgiving-base64).
    binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

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
  if (!isEncodedCapturePayload(payload)) return { ok: true, text: payload };
  const text = payload.trim();
  if (!text.startsWith(CAPTURE_GZIP_TAG)) return { ok: false, reason: 'unsupported-encoding' };
  if (text.length > MAX_ENCODED_CAPTURE_CHARS) return { ok: false, reason: 'too-large' };
  const Decompression = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (Decompression === undefined) return { ok: false, reason: 'unavailable' };

  const compressed = base64UrlToBytes(text.slice(CAPTURE_GZIP_TAG.length));
  if (compressed === null) return { ok: false, reason: 'malformed' };
  let inflated: Uint8Array | null;
  try {
    inflated = await gunzip(compressed, new Decompression('gzip'), maxBytes);
  } catch {
    // The stream errors on a bad header, checksum or length, and on truncated data.
    return { ok: false, reason: 'malformed' };
  }
  if (inflated === null) return { ok: false, reason: 'too-large' };
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(inflated) };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}
