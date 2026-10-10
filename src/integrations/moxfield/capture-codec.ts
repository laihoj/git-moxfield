/**
 * Server side of the capture transport encoding (ADR 0008): turns a capture payload as
 * received (compressed or plain, see `./capture-codec-protocol` for the wire format and the
 * reasoning behind the limits) back into the capture's JSON text, within hard size limits.
 *
 * Server-only (`node:zlib`). Client code imports `./capture-codec-protocol`.
 */
import 'server-only';

import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

import { DeckSourceError } from '../deck-source';

import {
  CAPTURE_GZIP_TAG,
  CAPTURE_TAG_NAMESPACE,
  DEFAULT_CAPTURE_CODEC_LIMITS,
  type CaptureCodecLimits,
} from './capture-codec-protocol';
import { MOXFIELD_SOURCE_ID } from './constants';

const gunzipAsync = promisify(gunzip);

/** The base64url alphabet (RFC 4648 §5), without padding. */
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Why a capture payload was refused. */
export type CapturePayloadErrorReason =
  /** Over one of the {@link CaptureCodecLimits}. */
  | 'too-large'
  /** Tagged as compressed, but not valid base64url, gzip or UTF-8. */
  | 'malformed'
  /** Tagged with an encoding this version does not know. */
  | 'unsupported-encoding';

/**
 * Brand for {@link isCapturePayloadError}, a registered symbol like `DeckSourceError`'s, so
 * that errors from another bundler module graph are still recognized.
 */
const CAPTURE_PAYLOAD_ERROR_BRAND: unique symbol = Symbol.for('git-moxfield.CapturePayloadError');

/**
 * A capture payload that cannot be decoded. It is a `DeckSourceError` with code `schema`
 * (unusable capture data), so code that handles the capture parser's errors handles it
 * too; {@link reason} tells a too-large payload (HTTP 413) from a broken one. The message
 * is user-facing and never contains the payload.
 */
export class CapturePayloadError extends DeckSourceError {
  readonly [CAPTURE_PAYLOAD_ERROR_BRAND] = true;
  readonly reason: CapturePayloadErrorReason;

  constructor(reason: CapturePayloadErrorReason, message: string, options: { cause?: unknown } = {}) {
    super('schema', message, { source: MOXFIELD_SOURCE_ID, cause: options.cause });
    this.reason = reason;
  }
}

export function isCapturePayloadError(value: unknown): value is CapturePayloadError {
  if (value instanceof CapturePayloadError) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<Record<typeof CAPTURE_PAYLOAD_ERROR_BRAND, unknown>>)[CAPTURE_PAYLOAD_ERROR_BRAND] ===
      true
  );
}

const DAMAGED = 'The compressed deck data is damaged';

const LIMIT_NAMES = ['maxEncodedChars', 'maxDecodedBytes', 'maxPlainBytes'] as const;

function assertLimits(limits: CaptureCodecLimits): void {
  for (const name of LIMIT_NAMES) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1) {
      throw new TypeError(`decodeCapturePayload: limits.${name} must be a positive integer`);
    }
  }
}

function decodePlain(input: string, limits: CaptureCodecLimits): string {
  // UTF-8 never takes fewer bytes than UTF-16 code units, so the length is a cheap first check.
  if (input.length > limits.maxPlainBytes || Buffer.byteLength(input, 'utf8') > limits.maxPlainBytes) {
    throw new CapturePayloadError(
      'too-large',
      `The deck data is too large to send uncompressed (limit ${limits.maxPlainBytes} bytes). Bookmarklets compress it in current browsers: create a new one on git-moxfield's Connect Moxfield page.`,
    );
  }
  return input;
}

async function inflate(compressed: Buffer, maxDecodedBytes: number): Promise<Buffer> {
  try {
    return await gunzipAsync(compressed, { maxOutputLength: maxDecodedBytes });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new CapturePayloadError(
        'too-large',
        `The deck data is too large (limit ${maxDecodedBytes} bytes uncompressed).`,
      );
    }
    // zlib's own errors (Z_DATA_ERROR, Z_BUF_ERROR, ...): bad header, checksum, truncation.
    if (typeof code === 'string' && code.startsWith('Z_')) {
      throw new CapturePayloadError('malformed', `${DAMAGED} (it is not valid gzip).`, { cause: error });
    }
    throw error;
  }
}

/**
 * Returns the capture's JSON text from a payload as received: the inflated text of a
 * compressed payload (`gm-gzip-base64url:…`), or a plain payload unchanged. Does not parse
 * the JSON; the capture parser does.
 *
 * Compressed payloads are checked before any work is done: their length (at most
 * `limits.maxEncodedChars`, tag included, surrounding whitespace ignored), then the strict
 * base64url alphabet and canonical form. Inflating stops as soon as the output exceeds
 * `limits.maxDecodedBytes`, so a decompression bomb costs at most that much memory, and
 * runs on the libuv thread pool, not the event loop. gzip's own checks (header, CRC-32,
 * length, truncation) apply; like gzip(1), zlib accepts concatenated members and ignores
 * trailing zero bytes, both harmless. The result must be valid UTF-8 (a byte order mark is
 * kept, as sent). Plain payloads are passed through when their UTF-8 size is at most
 * `limits.maxPlainBytes`.
 *
 * @throws {CapturePayloadError} with reason `too-large`, `malformed` or
 * `unsupported-encoding`; a `DeckSourceError` with code `schema`.
 * @throws {TypeError} when a limit is not a positive integer (a programming error).
 */
export async function decodeCapturePayload(
  input: string,
  limits: CaptureCodecLimits = DEFAULT_CAPTURE_CODEC_LIMITS,
): Promise<string> {
  assertLimits(limits);
  const text = input.trim();
  if (!text.startsWith(CAPTURE_TAG_NAMESPACE)) return decodePlain(input, limits);
  if (!text.startsWith(CAPTURE_GZIP_TAG)) {
    throw new CapturePayloadError(
      'unsupported-encoding',
      'The deck data is encoded in a format this version of git-moxfield does not support.',
    );
  }
  if (text.length > limits.maxEncodedChars) {
    throw new CapturePayloadError(
      'too-large',
      `The deck data is too large (limit ${limits.maxEncodedChars} characters compressed).`,
    );
  }

  const data = text.slice(CAPTURE_GZIP_TAG.length);
  // Buffer's base64 decoder skips characters it does not know and ignores unusable trailing
  // bits, so the alphabet is checked first and the result must encode back to the input.
  const compressed = BASE64URL.test(data) ? Buffer.from(data, 'base64url') : null;
  if (compressed?.toString('base64url') !== data) {
    throw new CapturePayloadError('malformed', `${DAMAGED} (it is not valid base64url).`);
  }

  const inflated = await inflate(compressed, limits.maxDecodedBytes);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(inflated);
  } catch (error) {
    throw new CapturePayloadError('malformed', `${DAMAGED} (it is not valid UTF-8 text).`, { cause: error });
  }
}
