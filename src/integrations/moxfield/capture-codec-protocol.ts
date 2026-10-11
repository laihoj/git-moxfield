/**
 * Transport encoding of captured decks (ADR 0008, "Capture payloads are compressed in the
 * browser"): the browser-safe half, shared by the bookmarklet, the capture page and the
 * server. The server's decoder is `./capture-codec`.
 *
 * Like `./capture-protocol`, this module is imported by client code: it must stay
 * browser-safe (no Node built-ins, no dependencies; it imports only `./capture-protocol`).
 *
 * ## Wire format
 *
 * A capture payload is the envelope JSON string (`CaptureEnvelope`, or any other capture
 * text the server accepts) in one of two encodings:
 *
 * - **Compressed** (what current bookmarklets send):
 *
 *       gm-gzip-base64url:<data>
 *
 *   `<data>` is the UTF-8 bytes of the JSON text, compressed as a single gzip member
 *   (RFC 1952; the browser's `CompressionStream('gzip')`), in base64url without padding
 *   (RFC 4648 §5, `[A-Za-z0-9_-]`). Surrounding whitespace is ignored, nothing else is:
 *   no line breaks, padding or standard-alphabet characters inside `<data>`.
 *
 * - **Plain**: the JSON text itself, untagged. JSON text never starts with a letter, so
 *   the two cannot be confused. Plain payloads come from bookmarklets made before
 *   compression, from browsers without `CompressionStream` (before Chrome 80, Firefox 113
 *   and Safari 16.4; the encoder falls back to plain there) and from manual pastes.
 *
 * Text starting with {@link CAPTURE_TAG_NAMESPACE} (after whitespace) is always treated as
 * tagged: the namespace is reserved for encodings, and a tag the server does not know is
 * rejected as unsupported instead of being parsed as JSON. Nothing else is reserved, so a
 * pasted URL or other junk still reaches the JSON parser and its helpful error message.
 *
 * The payload is the same text on every path: the `json` field of the PAYLOAD message
 * (popup mode), the `payload` string of `POST /api/capture` and the `payload` field of the
 * same-tab form. The envelope's `version` describes the envelope only; the tag makes the
 * transport encoding self-describing, so compression needs no envelope version of its own.
 *
 * Why base64url: it is plain text, which `postMessage`, JSON bodies and form fields all
 * carry, and none of its characters needs escaping in JSON or percent-encoding in an
 * `application/x-www-form-urlencoded` form (standard base64's `+`, `/` and `=` each become
 * three bytes there). A compressed payload of `n` characters therefore costs `n` bytes
 * (plus the 2 bytes of the tag's `:` as `%3A` in a form) on every path, which makes the
 * request-size arithmetic below exact.
 *
 * ## Size limits
 *
 * Netlify rejects request bodies over 6,000,000 bytes before the app runs (with a 500, not
 * a 413), and may hand a body to the function base64-encoded (4/3 larger) inside a
 * 6,000,000-byte invocation payload. Every limit below therefore keeps the largest body it
 * admits under 6,000,000 bytes even after that expansion, so that every payload the app
 * accepts also gets through the platform, and the app's own "too large" message is what
 * users see. A real 835,292-byte Moxfield deck compressed to 110,327 bytes (7.6:1),
 * 147,103 characters encoded: about 147 KB on the wire instead of about 1.2 MB as plain
 * JSON in a form (1.44x percent-encoding) or 0.93 MB in a JSON body (1.11x escaping).
 *
 * - {@link MAX_ENCODED_CAPTURE_CHARS} (2,000,000 characters, tag included): at most
 *   1.5 MB of gzip, which covers {@link MAX_DECODED_CAPTURE_BYTES} for any envelope that
 *   compresses at least 5.4:1. The largest body is then about 2.0 MB on both capture routes
 *   (2.7 MB if base64-encoded by the platform).
 * - {@link MAX_DECODED_CAPTURE_BYTES} (= `MAX_CAPTURE_BYTES`, 8,000,000 bytes): the
 *   envelope's size once inflated, the limit the capture parser applies anyway. Inflating
 *   stops as soon as the output exceeds it (decompression-bomb safe).
 * - {@link MAX_PLAIN_CAPTURE_BYTES} (1,400,000 UTF-8 bytes): uncompressed payloads. In the
 *   worst case a form triples them (every byte percent-encoded) and a JSON body doubles
 *   them (every character escaped): 3 x 1,400,000 + 64 KiB = 4,265,536 bytes, and
 *   5,687,382 bytes if base64-encoded by the platform. A typical deck (1.44x in a form) of
 *   this size makes a body of about 2.0 MB.
 */
import { MAX_CAPTURE_BYTES } from './capture-protocol';

/** Prefix reserved for transport encodings: text starting with it is never parsed as JSON. */
export const CAPTURE_TAG_NAMESPACE = 'gm-';

/** Tag of a gzip-compressed, base64url-encoded capture payload (see the module comment). */
export const CAPTURE_GZIP_TAG = `${CAPTURE_TAG_NAMESPACE}gzip-base64url:`;

/** Largest compressed payload, in characters including the tag. */
export const MAX_ENCODED_CAPTURE_CHARS = 2_000_000;

/** Largest inflated payload, in bytes of UTF-8: the envelope limit, `MAX_CAPTURE_BYTES`. */
export const MAX_DECODED_CAPTURE_BYTES = MAX_CAPTURE_BYTES;

/** Largest untagged (plain JSON) payload, in bytes of UTF-8. */
export const MAX_PLAIN_CAPTURE_BYTES = 1_400_000;

/** Size limits of the server's decoder (`decodeCapturePayload` in `./capture-codec`). */
export interface CaptureCodecLimits {
  /** Largest compressed payload, in characters including the tag (ASCII, so also bytes). */
  readonly maxEncodedChars: number;
  /** Largest inflated payload, in bytes. */
  readonly maxDecodedBytes: number;
  /** Largest plain (untagged) payload, in bytes of UTF-8. */
  readonly maxPlainBytes: number;
}

/** The limits of the capture endpoints. */
export const DEFAULT_CAPTURE_CODEC_LIMITS: CaptureCodecLimits = Object.freeze({
  maxEncodedChars: MAX_ENCODED_CAPTURE_CHARS,
  maxDecodedBytes: MAX_DECODED_CAPTURE_BYTES,
  maxPlainBytes: MAX_PLAIN_CAPTURE_BYTES,
});

/**
 * Bytes per `btoa` call when encoding. A multiple of 3, so that only the last chunk is
 * padded and the chunks' base64 can simply be concatenated, and far below the argument
 * count that `Function.prototype.apply` and spread calls accept in every engine
 * (JavaScriptCore's limit is 65,536), so that megabytes never overflow the stack.
 */
const BASE64_CHUNK_BYTES = 3 * 8192;

/** The base64url alphabet (RFC 4648 §5), without padding. */
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Whether `data` consists of base64url characters only (nothing about its length or canonical form). */
export function isBase64Url(data: string): boolean {
  return BASE64URL.test(data);
}

/** Why a capture payload was refused, in the steps every decoder runs the same way. */
export type CapturePayloadFailure =
  /** Over one of the {@link CaptureCodecLimits}. */
  | 'too-large'
  /** Tagged as compressed, but not valid base64url, gzip or UTF-8. */
  | 'malformed'
  /** Tagged with an encoding this version does not know. */
  | 'unsupported-encoding';

/** What {@link parseCapturePayload} found: how the payload is encoded, or why it is refused. */
export type ParsedCapturePayload =
  /** Untagged: the text itself, as received. */
  | { kind: 'plain'; text: string }
  /** Tagged as gzip: the base64url `data` after the tag (not yet checked). */
  | { kind: 'compressed'; data: string }
  | { kind: 'rejected'; reason: CapturePayloadFailure };

/**
 * The first steps of reading a capture payload, the same for the server's decoder
 * (`./capture-codec`) and the paste form's preview, in this order: surrounding whitespace
 * is ignored; text in the {@link CAPTURE_TAG_NAMESPACE} must carry a known tag; and a
 * compressed payload must fit `maxEncodedChars` (tag included). Plain payloads are
 * returned unchanged (their size is the caller's business); the base64url data of a
 * compressed one still has to be decoded ({@link base64UrlToBytes}, or the server's own).
 */
export function parseCapturePayload(input: string, maxEncodedChars: number): ParsedCapturePayload {
  const text = input.trim();
  if (!text.startsWith(CAPTURE_TAG_NAMESPACE)) return { kind: 'plain', text: input };
  if (!text.startsWith(CAPTURE_GZIP_TAG)) return { kind: 'rejected', reason: 'unsupported-encoding' };
  if (text.length > maxEncodedChars) return { kind: 'rejected', reason: 'too-large' };
  return { kind: 'compressed', data: text.slice(CAPTURE_GZIP_TAG.length) };
}

/** `bytes` as base64url without padding (RFC 4648 §5), in {@link BASE64_CHUNK_BYTES} chunks. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let base64 = '';
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK_BYTES) {
    base64 += btoa(String.fromCharCode(...bytes.subarray(start, start + BASE64_CHUNK_BYTES)));
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The bytes of canonical base64url `data`, or `null` when it is not: characters outside the
 * alphabet, a length that cannot end a group, or an encoding that is not the canonical one
 * of its bytes (unused trailing bits set), which `atob` would silently accept. The same
 * text is accepted here and by the server's decoder.
 */
export function base64UrlToBytes(data: string): Uint8Array<ArrayBuffer> | null {
  // A single character in the last group carries no whole byte: never valid.
  if (!isBase64Url(data) || data.length % 4 === 1) return null;
  let binary: string;
  try {
    // `atob` accepts unpadded input (forgiving-base64).
    binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytesToBase64Url(bytes) === data ? bytes : null;
}

/** `bytes` as UTF-8 text (a byte order mark is kept, as sent), or `null` when they are not valid UTF-8. */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Whether `payload` is tagged, i.e. not plain JSON (it may still use an encoding this
 * version does not know). Cheap: looks at the first characters only.
 */
export function isEncodedCapturePayload(payload: string): boolean {
  return payload.trimStart().startsWith(CAPTURE_TAG_NAMESPACE);
}

/**
 * Whether `text` takes more than `maxBytes` bytes as UTF-8, counted without encoding it:
 * the UTF-16 length is a lower bound (every code unit takes at least a byte), so the exact
 * count only runs for text that might fit. A lone surrogate counts as the 3 bytes of U+FFFD,
 * as encoders write it.
 */
export function exceedsUtf8Bytes(text: string, maxBytes: number): boolean {
  if (text.length > maxBytes) return true;
  let bytes = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (bytes > maxBytes) return true;
  }
  return false;
}

/**
 * Cheap client-side pre-check, so that the capture page can show its own message instead
 * of sending a request that is bound to fail. The server's decoder stays authoritative:
 * plain payloads are measured in UTF-16 code units here, a lower bound of their UTF-8 size.
 */
export function exceedsCapturePayloadLimit(
  payload: string,
  limits: CaptureCodecLimits = DEFAULT_CAPTURE_CODEC_LIMITS,
): boolean {
  return isEncodedCapturePayload(payload)
    ? payload.trim().length > limits.maxEncodedChars
    : payload.length > limits.maxPlainBytes;
}

/**
 * Encodes capture text for sending, for app pages (the bookmarklet embeds
 * {@link ENCODE_CAPTURE_PAYLOAD_SOURCE} instead, the same algorithm as source text).
 * Returns the compressed form, or `text` unchanged when the browser has no
 * `CompressionStream`.
 */
export async function encodeCapturePayload(text: string): Promise<string> {
  const Compression = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (Compression === undefined) return text;
  const compressed = new Blob([text]).stream().pipeThrough(new Compression('gzip'));
  return CAPTURE_GZIP_TAG + bytesToBase64Url(new Uint8Array(await new Response(compressed).arrayBuffer()));
}

/**
 * Source text of the bookmarklet's encoder: an ES2020 `async (text) => string` arrow
 * function expression, self-contained (browser globals only) and equivalent to
 * {@link encodeCapturePayload}. Embed it as `const encode = ${ENCODE_CAPTURE_PAYLOAD_SOURCE};`.
 *
 * It survives the bookmarklet builder's compaction (lines trimmed and joined with `\n`):
 * no comments, template literals or multi-line strings. `new Blob([text])` encodes the
 * text as UTF-8; an envelope made by `JSON.stringify` never contains lone surrogates, so
 * the round trip is exact. The bytes go to `btoa` in {@link BASE64_CHUNK_BYTES} chunks,
 * never as one huge argument list.
 */
export const ENCODE_CAPTURE_PAYLOAD_SOURCE = String.raw`async (text) => {
  if (typeof CompressionStream !== 'function') return text;
  const gzip = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(gzip).arrayBuffer());
  let base64 = '';
  for (let start = 0; start < bytes.length; start += ${BASE64_CHUNK_BYTES}) {
    base64 += btoa(String.fromCharCode.apply(null, bytes.subarray(start, start + ${BASE64_CHUNK_BYTES})));
  }
  return ${JSON.stringify(CAPTURE_GZIP_TAG)} + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}`;
