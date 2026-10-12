/**
 * The server's decoder (`decodeCapturePayload`) and the paste form's preview
 * (`inflateCapturePayload`) read the same wire format (ADR 0008): for every vector here,
 * the same text for a good payload and the same reason for a refused one. They share the
 * first steps (`parseCapturePayload`); inflating is their own. Known divergences: the
 * preview leaves a plain payload's size to its caller (the server refuses one over
 * `MAX_PLAIN_CAPTURE_BYTES`), and zlib ignores zero bytes after the gzip member, which a
 * browser's `DecompressionStream` need not.
 */
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { inflateCapturePayload } from '@/components/capture/capture-payload';
import { decodeCapturePayload } from '@/integrations/moxfield/capture-codec';
import {
  CAPTURE_GZIP_TAG,
  MAX_DECODED_CAPTURE_BYTES,
  MAX_ENCODED_CAPTURE_CHARS,
} from '@/integrations/moxfield/capture-codec-protocol';
import { gzipPayload, UNICODE_SAMPLE } from '@tests/support/capture-codec';

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** A payload of canonical base64url whose last group has unused bits, with one of them set. */
function withNonCanonicalTrailingBits(): string {
  for (let padding = 0; padding < 8; padding++) {
    const payload = gzipPayload(`{"a":"${'x'.repeat(padding)}"}`);
    const data = payload.slice(CAPTURE_GZIP_TAG.length);
    if (data.length % 4 === 0) continue;
    const last = BASE64URL_ALPHABET.indexOf(data.at(-1) ?? '');
    return payload.slice(0, -1) + (BASE64URL_ALPHABET[last | 1] ?? '');
  }
  throw new Error('No payload with unused trailing bits');
}

/** A compressed payload of exactly `length` characters (stored, not deflated) and its text. */
function payloadOfLength(length: number): { payload: string; text: string } {
  const encode = (size: number) =>
    CAPTURE_GZIP_TAG + gzipSync(Buffer.alloc(size, 'x'), { level: 0 }).toString('base64url');
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (encode(middle).length < length) low = middle + 1;
    else high = middle;
  }
  const payload = encode(low);
  if (payload.length !== length) throw new Error(`No stored gzip payload is ${length} characters long`);
  return { payload, text: 'x'.repeat(low) };
}

const AT_ENCODED_LIMIT = payloadOfLength(MAX_ENCODED_CAPTURE_CHARS);

/** Payloads both read as `text`: `payload` as received. */
const GOOD: [name: string, payload: string, text: string][] = [
  ['plain JSON', '{"a":1}', '{"a":1}'],
  ['plain JSON with surrounding whitespace, as received', '  {"a":1}\n', '  {"a":1}\n'],
  [
    'plain text that is not JSON (the capture parser says so)',
    'https://moxfield.com/decks/abc',
    'https://moxfield.com/decks/abc',
  ],
  [
    'a compressed capture',
    gzipPayload(JSON.stringify({ deck: UNICODE_SAMPLE })),
    JSON.stringify({ deck: UNICODE_SAMPLE }),
  ],
  [
    'a compressed capture with a byte order mark (kept, as sent)',
    gzipPayload('\ufeff{"a":1}'),
    '\ufeff{"a":1}',
  ],
  ['the empty text, compressed', gzipPayload(''), ''],
  ['a compressed capture with surrounding whitespace', ` \n${gzipPayload('{"a":1}')}\n `, '{"a":1}'],
  ['a compressed payload of exactly the most characters', AT_ENCODED_LIMIT.payload, AT_ENCODED_LIMIT.text],
  [
    'a compressed payload that inflates to exactly the most bytes',
    gzipPayload('x'.repeat(MAX_DECODED_CAPTURE_BYTES)),
    'x'.repeat(MAX_DECODED_CAPTURE_BYTES),
  ],
];

const REFUSED: [string, string, 'too-large' | 'malformed' | 'unsupported-encoding'][] = [
  ['an unknown tag', 'gm-zstd-base64url:AAAA', 'unsupported-encoding'],
  ['an unknown tag after whitespace', ' \ngm-other:x', 'unsupported-encoding'],
  [
    'more characters than a compressed payload may have',
    `${CAPTURE_GZIP_TAG}${'A'.repeat(MAX_ENCODED_CAPTURE_CHARS)}`,
    'too-large',
  ],
  ['one character more than a compressed payload may have', `${AT_ENCODED_LIMIT.payload}A`, 'too-large'],
  [
    'a compressed payload that inflates to one byte more than the most',
    gzipPayload('x'.repeat(MAX_DECODED_CAPTURE_BYTES + 1)),
    'too-large',
  ],
  ['characters outside the base64url alphabet', `${CAPTURE_GZIP_TAG}ab+/`, 'malformed'],
  ['padding', `${CAPTURE_GZIP_TAG}AAAA==`, 'malformed'],
  ['a line break inside the data', `${CAPTURE_GZIP_TAG}AAAA\nAAAA`, 'malformed'],
  ['a length that cannot end a group', `${CAPTURE_GZIP_TAG}AAAAA`, 'malformed'],
  ['unused trailing bits that are set (not canonical)', withNonCanonicalTrailingBits(), 'malformed'],
  [
    'data that is not gzip',
    `${CAPTURE_GZIP_TAG}${Buffer.from('hello, not gzip').toString('base64url')}`,
    'malformed',
  ],
  [
    'gzip that is cut off',
    `${CAPTURE_GZIP_TAG}${gzipSync('{"a":"truncated"}').subarray(0, -6).toString('base64url')}`,
    'malformed',
  ],
  ['gzip of bytes that are not UTF-8', gzipPayload(new Uint8Array([0xff, 0xfe, 0xfd])), 'malformed'],
];

describe('capture payload decoding, on the server and in the paste form', () => {
  it.each(GOOD)('both read %s the same', async (_name, payload, text) => {
    expect(await decodeCapturePayload(payload)).toBe(text);
    expect(await inflateCapturePayload(payload)).toEqual({ ok: true, text });
  });

  it.each(REFUSED)('both refuse %s for the same reason', async (_name, payload, reason) => {
    await expect(decodeCapturePayload(payload)).rejects.toMatchObject({ reason });
    expect(await inflateCapturePayload(payload)).toEqual({ ok: false, reason });
  });
});
