/**
 * Test data for the capture transport encoding (`src/integrations/moxfield/capture-codec*`),
 * shared by the Node unit tests and the Chromium round trip.
 */
import { gzipSync } from 'node:zlib';

import { CAPTURE_GZIP_TAG, MAX_ENCODED_CAPTURE_CHARS } from '@/integrations/moxfield/capture-codec-protocol';
import { fixtureCaptureEnvelope, v1Primer } from '@/integrations/moxfield/test-fixtures';

/** Netlify's cap on a function's request payload (ADR 0008). */
export const NETLIFY_MAX_PAYLOAD_BYTES = 6_000_000;

/** Text outside ASCII and the BMP, to catch any encoding that is not UTF-8 end to end. */
export const UNICODE_SAMPLE = 'Æther Vial, Lim-Dûl, 「龍」, Sigarda 🐉, “quotes”,   and \\ "escapes"';

/** A capture envelope JSON string like the bookmarklet's, built from the Moxfield fixtures. */
export function envelopeJson(): string {
  const primer = v1Primer();
  primer.content = `${primer.content}\n\n${UNICODE_SAMPLE}`;
  return JSON.stringify(fixtureCaptureEnvelope({ capturedAt: '2026-10-10T12:00:00.000Z', primer }));
}

/** Mostly ASCII, plus characters of 2, 3 and 4 bytes in UTF-8 (the last one is 2 UTF-16 units). */
const NOISE_ALPHABET: readonly string[] = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ,.:;-_/+=!?'.split(''),
  'é',
  'ß',
  'Ω',
  '龍',
  '🐉',
];

/**
 * A JSON document of about `length` characters of deterministic pseudo-random text (mostly
 * ASCII, some 2-, 3- and 4-byte UTF-8 characters) that gzip can barely compress, so that its
 * compressed form is about as large as the text itself.
 */
export function incompressibleJson(length: number, seed = 0x5eed): string {
  // mulberry32: a tiny, well-distributed PRNG, so that failures are reproducible.
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const parts: string[] = [];
  for (let i = 0; i < length; i += 1) {
    parts.push(NOISE_ALPHABET[Math.floor(next() * NOISE_ALPHABET.length)] ?? '?');
  }
  return JSON.stringify({ noise: parts.join('') });
}

/** Encodes like the browser, with Node's zlib: for building server-side test inputs. */
export function gzipPayload(bytes: Uint8Array | string): string {
  return (
    CAPTURE_GZIP_TAG +
    gzipSync(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes).toString('base64url')
  );
}

/** The largest compressed payload the decoder accepts (its data need not be valid gzip). */
export function largestEncodedPayload(): string {
  return CAPTURE_GZIP_TAG + 'A'.repeat(MAX_ENCODED_CAPTURE_CHARS - CAPTURE_GZIP_TAG.length);
}

/** A `CompressionStream` that cannot be constructed (`new` on a function that throws). */
export function brokenCompressionStream(): never {
  throw new TypeError('CompressionStream is broken');
}
