import { runInNewContext, Script } from 'node:vm';
import { gzipSync } from 'node:zlib';

import { Linter } from 'eslint';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { envelopeJson, gzipPayload, incompressibleJson, UNICODE_SAMPLE } from '@tests/support/capture-codec';

import { formatBytes } from '@/core/text';

import { DeckSourceError, isDeckSourceError } from '../deck-source';

import {
  CapturePayloadError,
  decodeCapturePayload,
  isCapturePayloadError,
  type CapturePayloadErrorReason,
} from './capture-codec';
import {
  CAPTURE_GZIP_TAG,
  DEFAULT_CAPTURE_CODEC_LIMITS,
  ENCODE_CAPTURE_PAYLOAD_SOURCE,
  encodeCapturePayload,
  exceedsCapturePayloadLimit,
  exceedsUtf8Bytes,
  isEncodedCapturePayload,
  MAX_DECODED_CAPTURE_BYTES,
  MAX_ENCODED_CAPTURE_CHARS,
  MAX_PLAIN_CAPTURE_BYTES,
  type CaptureCodecLimits,
} from './capture-codec-protocol';
import { CAPTURE_FORM_FIELD, CAPTURE_FORM_TOKEN_FIELD, MAX_CAPTURE_BYTES } from './capture-protocol';
import { compactBookmarkletSource } from './capture';

type Encoder = (text: string) => Promise<string>;

const SMALL_LIMITS: CaptureCodecLimits = { maxEncodedChars: 200, maxDecodedBytes: 100, maxPlainBytes: 50 };

/** The bookmarklet encoder, evaluated in this realm (Node has the same Web APIs). */
function sourceEncoder(source = ENCODE_CAPTURE_PAYLOAD_SOURCE): Encoder {
  return new Script(`(${source})`).runInThisContext() as Encoder;
}

async function rejection(promise: Promise<unknown>): Promise<CapturePayloadError> {
  try {
    await promise;
  } catch (error) {
    if (isCapturePayloadError(error)) return error;
    throw error;
  }
  throw new Error('Expected the payload to be rejected');
}

async function expectRejected(
  input: string,
  reason: CapturePayloadErrorReason,
  limits?: CaptureCodecLimits,
): Promise<CapturePayloadError> {
  const error = await rejection(decodeCapturePayload(input, limits));
  expect(error.reason).toBe(reason);
  return error;
}

/** Replaces the encoded data of a compressed payload. */
function withData(payload: string, transform: (data: string) => string): string {
  return CAPTURE_GZIP_TAG + transform(payload.slice(CAPTURE_GZIP_TAG.length));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decodeCapturePayload: compressed payloads', () => {
  it('inflates gzip from Node back to the exact text', async () => {
    const json = envelopeJson();
    await expect(decodeCapturePayload(gzipPayload(json))).resolves.toBe(json);
    await expect(decodeCapturePayload(gzipPayload(UNICODE_SAMPLE))).resolves.toBe(UNICODE_SAMPLE);
  });

  it('round-trips the bookmarklet encoder, also after the bookmarklet compaction', async () => {
    const json = envelopeJson();
    for (const encode of [
      sourceEncoder(),
      sourceEncoder(compactBookmarkletSource(ENCODE_CAPTURE_PAYLOAD_SOURCE)),
    ]) {
      const encoded = await encode(json);
      expect(encoded).toMatch(/^gm-gzip-base64url:[A-Za-z0-9_-]+$/);
      expect(encoded.length).toBeLessThan(json.length);
      await expect(decodeCapturePayload(encoded)).resolves.toBe(json);
    }
  });

  it('encodes exactly like the typed encoder, for short, unicode and multi-chunk text', async () => {
    const texts = ['', 'a', '{}', envelopeJson(), UNICODE_SAMPLE, incompressibleJson(200_000)];
    for (const source of [
      ENCODE_CAPTURE_PAYLOAD_SOURCE,
      compactBookmarkletSource(ENCODE_CAPTURE_PAYLOAD_SOURCE),
    ]) {
      const encode = sourceEncoder(source);
      for (const text of texts) {
        expect(await encode(text)).toBe(await encodeCapturePayload(text));
      }
    }
  });

  it('round-trips the typed encoder across many btoa chunks', async () => {
    // Noise that gzip barely shrinks: about 1.3 MB of gzip, converted in ~50 chunks.
    const json = incompressibleJson(1_500_000);
    const encoded = await encodeCapturePayload(json);
    expect(encoded.length).toBeGreaterThan(1_600_000);
    expect(encoded.length).toBeLessThan(MAX_ENCODED_CAPTURE_CHARS);
    await expect(decodeCapturePayload(encoded)).resolves.toBe(json);
  });

  it('round-trips the empty text and texts of every length modulo 3', async () => {
    for (const text of ['', 'a', 'ab', 'abc', '{}', '[1]']) {
      await expect(decodeCapturePayload(await encodeCapturePayload(text))).resolves.toBe(text);
    }
  });

  it('ignores whitespace around the payload, as pasted text has it', async () => {
    const json = envelopeJson();
    await expect(decodeCapturePayload(`\n  ${gzipPayload(json)} \r\n`)).resolves.toBe(json);
  });

  it('accepts a payload of exactly the limits', async () => {
    const text = 'x'.repeat(SMALL_LIMITS.maxDecodedBytes);
    const encoded = gzipPayload(text);
    const limits = { ...SMALL_LIMITS, maxEncodedChars: encoded.length };
    await expect(decodeCapturePayload(encoded, limits)).resolves.toBe(text);
  });

  it('keeps a byte order mark, as sent', async () => {
    await expect(decodeCapturePayload(gzipPayload('﻿{}'))).resolves.toBe('﻿{}');
  });
});

describe('exceedsUtf8Bytes', () => {
  it('agrees with the UTF-8 size Buffer reports, for every kind of character', () => {
    const samples = ['', 'abc', 'é', '€', '😀', 'a😀b€é', UNICODE_SAMPLE, '\ud800', 'x\udc00y', 'ab\ud83d'];
    for (const text of samples) {
      const size = Buffer.byteLength(text, 'utf8');
      expect(exceedsUtf8Bytes(text, size), JSON.stringify(text)).toBe(false);
      if (size > 0) expect(exceedsUtf8Bytes(text, size - 1), JSON.stringify(text)).toBe(true);
    }
  });

  it('answers from the length alone for text that is too long whatever it contains', () => {
    expect(exceedsUtf8Bytes('x'.repeat(11), 10)).toBe(true);
    expect(exceedsUtf8Bytes('x'.repeat(10), 10)).toBe(false);
  });
});

describe('decodeCapturePayload: limits', () => {
  it('rejects a compressed payload over the length limit before decoding it', async () => {
    const encoded = gzipPayload('x'.repeat(10));
    await expectRejected(encoded, 'too-large', { ...SMALL_LIMITS, maxEncodedChars: encoded.length - 1 });
    // Even when its data is garbage: the length is checked first.
    const error = await expectRejected(`${CAPTURE_GZIP_TAG}${'!'.repeat(300)}`, 'too-large', SMALL_LIMITS);
    expect(error.message).toBe('The deck data is too large (limit 200 B compressed).');
  });

  it('stops inflating one byte past the decoded limit', async () => {
    const error = await expectRejected(
      gzipPayload('x'.repeat(SMALL_LIMITS.maxDecodedBytes + 1)),
      'too-large',
      SMALL_LIMITS,
    );
    expect(error.message).toBe('The deck data is too large (limit 100 B uncompressed).');
  });

  it('defuses a decompression bomb with the default limits', async () => {
    // 32 MiB of zeros: about 32 KB compressed, well within the encoded limit.
    const bomb = gzipPayload(new Uint8Array(32 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(MAX_ENCODED_CAPTURE_CHARS / 10);
    const error = await expectRejected(bomb, 'too-large');
    expect(error.message).toContain(`limit ${formatBytes(MAX_DECODED_CAPTURE_BYTES)} uncompressed`);
  });

  it('rejects a plain payload over the limit, counted in UTF-8 bytes', async () => {
    const ascii = 'x'.repeat(SMALL_LIMITS.maxPlainBytes);
    await expect(decodeCapturePayload(ascii, SMALL_LIMITS)).resolves.toBe(ascii);
    await expectRejected(`${ascii}x`, 'too-large', SMALL_LIMITS);
    // 25 characters, but 75 bytes of UTF-8.
    const error = await expectRejected('龍'.repeat(25), 'too-large', SMALL_LIMITS);
    expect(error.message).toContain('too large to send uncompressed (limit 50 B)');
  });

  it('refuses limits that are not positive integers', async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(decodeCapturePayload('{}', { ...SMALL_LIMITS, maxDecodedBytes: bad })).rejects.toThrow(
        new TypeError('decodeCapturePayload: limits.maxDecodedBytes must be a positive integer'),
      );
    }
  });
});

describe('decodeCapturePayload: malformed payloads', () => {
  const valid = gzipPayload(envelopeJson());

  it.each([
    ['standard base64 characters', (data: string) => `${data.slice(0, -1)}+`],
    ['a slash', (data: string) => `/${data.slice(1)}`],
    ['padding', (data: string) => `${data}==`],
    ['an inner line break', (data: string) => `${data.slice(0, 40)}\n${data.slice(40)}`],
    ['an inner space', (data: string) => `${data.slice(0, 40)} ${data.slice(40)}`],
    ['a non-ASCII character', (data: string) => `${data}é`],
  ])('rejects data with %s as not base64url', async (_name, transform) => {
    const error = await expectRejected(withData(valid, transform), 'malformed');
    expect(error.message).toBe('The compressed deck data is damaged (it is not valid base64url).');
  });

  it('rejects base64url that Buffer would silently repair', async () => {
    // A length of 4n + 1 cannot be base64: Buffer drops the last character.
    expect(Buffer.from('AAAAA', 'base64url')).toEqual(Buffer.from('AAAA', 'base64url'));
    await expectRejected(`${CAPTURE_GZIP_TAG}AAAAA`, 'malformed');
    // Unused bits set: 'QQ' is the canonical encoding of 'A', 'QR' decodes to the same byte.
    expect(Buffer.from('QR', 'base64url')).toEqual(Buffer.from('A'));
    await expectRejected(`${CAPTURE_GZIP_TAG}QR`, 'malformed');
  });

  /** A compressed payload of `bytes`, which need not be valid gzip. */
  const fromBytes = (bytes: Uint8Array): string =>
    CAPTURE_GZIP_TAG + Buffer.from(bytes).toString('base64url');
  const gzipped = gzipSync(Buffer.from(envelopeJson()));

  it.each([
    ['no data at all', new Uint8Array()],
    ['bytes that are not gzip', Buffer.from('{"not":"gzip"}')],
    ['a truncated stream', gzipped.subarray(0, -3)],
    ['trailing garbage', Buffer.concat([gzipped, Buffer.from('garbage')])],
    ['a corrupted checksum', Buffer.concat([gzipped.subarray(0, -8), Buffer.alloc(8, 0xa5)])],
  ])('rejects %s as not gzip', async (_name, bytes) => {
    const error = await expectRejected(fromBytes(bytes), 'malformed');
    expect(error.message).toBe('The compressed deck data is damaged (it is not valid gzip).');
  });

  it('rejects inflated bytes that are not UTF-8', async () => {
    for (const bytes of [[0xff, 0xfe], [0xc3], [0xed, 0xa0, 0x80] /* an encoded surrogate */]) {
      const error = await expectRejected(gzipPayload(new Uint8Array(bytes)), 'malformed');
      expect(error.message).toBe('The compressed deck data is damaged (it is not valid UTF-8 text).');
    }
  });

  it('rejects an unknown tag in the reserved namespace', async () => {
    for (const input of ['gm-brotli-base64url:AAAA', 'gm-gzip-base64:H4sI', '  gm-']) {
      const error = await expectRejected(input, 'unsupported-encoding');
      expect(error.message).toBe(
        'The deck data is encoded in a format this version of git-moxfield does not support.',
      );
    }
  });
});

describe('decodeCapturePayload: plain payloads', () => {
  it('passes untagged text through unchanged, whitespace included', async () => {
    const json = ` \n${envelopeJson()}\n`;
    await expect(decodeCapturePayload(json)).resolves.toBe(json);
  });

  it('leaves non-JSON text to the JSON parser and its messages', async () => {
    for (const text of ['https://moxfield.com/decks/abc', 'gzip-base64url:AAAA', 'not json', '']) {
      await expect(decodeCapturePayload(text)).resolves.toBe(text);
    }
  });
});

describe('CapturePayloadError', () => {
  it('is an unusable-capture DeckSourceError, recognized across module graphs', () => {
    const error = new CapturePayloadError('malformed', 'Broken.');
    expect(error).toBeInstanceOf(DeckSourceError);
    expect(isDeckSourceError(error)).toBe(true);
    expect(error.code).toBe('schema');
    expect(error.source).toBe('moxfield');
    expect(isCapturePayloadError(error)).toBe(true);
    expect(isCapturePayloadError({ [Symbol.for('git-moxfield.CapturePayloadError')]: true })).toBe(true);
    expect(isCapturePayloadError(new DeckSourceError('schema', 'x', { source: 'moxfield' }))).toBe(false);
    expect(isCapturePayloadError(null)).toBe(false);
  });
});

describe('browser-side encoders', () => {
  it('is ES2020 source the bookmarklet can embed', () => {
    const linter = new Linter();
    const es2020 = { languageOptions: { ecmaVersion: 2020, sourceType: 'script' } } as const;
    // The check itself works: numeric separators are ES2021.
    expect(linter.verify('const n = 1_000;', es2020)).toEqual([expect.objectContaining({ fatal: true })]);
    for (const source of [
      ENCODE_CAPTURE_PAYLOAD_SOURCE,
      compactBookmarkletSource(ENCODE_CAPTURE_PAYLOAD_SOURCE),
    ]) {
      expect(linter.verify(`const encode = ${source};`, es2020)).toEqual([]);
    }
  });

  it('send plain text from browsers without CompressionStream', async () => {
    const json = envelopeJson();
    const withoutCompression = runInNewContext(`(${ENCODE_CAPTURE_PAYLOAD_SOURCE})`, {
      Blob,
      Response,
      btoa,
    }) as Encoder;
    await expect(withoutCompression(json)).resolves.toBe(json);
    vi.stubGlobal('CompressionStream', undefined);
    await expect(encodeCapturePayload(json)).resolves.toBe(json);
  });

  it('tell tagged from plain payloads, and pre-check their size', () => {
    expect(isEncodedCapturePayload(gzipPayload('{}'))).toBe(true);
    expect(isEncodedCapturePayload(' \ngm-other:x')).toBe(true);
    expect(isEncodedCapturePayload('{"gm-":1}')).toBe(false);

    expect(exceedsCapturePayloadLimit(`${CAPTURE_GZIP_TAG}${'A'.repeat(182)}`, SMALL_LIMITS)).toBe(false);
    expect(exceedsCapturePayloadLimit(`${CAPTURE_GZIP_TAG}${'A'.repeat(183)}`, SMALL_LIMITS)).toBe(true);
    expect(exceedsCapturePayloadLimit('x'.repeat(50), SMALL_LIMITS)).toBe(false);
    expect(exceedsCapturePayloadLimit('x'.repeat(51), SMALL_LIMITS)).toBe(true);
    expect(exceedsCapturePayloadLimit('x'.repeat(MAX_PLAIN_CAPTURE_BYTES + 1))).toBe(true);
  });
});

describe('limits', () => {
  /** Netlify's request body cap, and what fits in it if the body is base64-encoded. */
  const NETLIFY_BODY_CAP = 6_000_000;
  const BASE64_SAFE_BODY = (NETLIFY_BODY_CAP * 3) / 4;
  const ROUTE_OVERHEAD = 64 * 1024;
  const key = `gmk_${'A'.repeat(43)}`;

  it('are the endpoint defaults, with the envelope limit as the decoded limit', () => {
    expect(DEFAULT_CAPTURE_CODEC_LIMITS).toEqual({
      maxEncodedChars: MAX_ENCODED_CAPTURE_CHARS,
      maxDecodedBytes: MAX_DECODED_CAPTURE_BYTES,
      maxPlainBytes: MAX_PLAIN_CAPTURE_BYTES,
    });
    expect(Object.isFrozen(DEFAULT_CAPTURE_CODEC_LIMITS)).toBe(true);
    expect(MAX_DECODED_CAPTURE_BYTES).toBe(MAX_CAPTURE_BYTES);
  });

  it('keep the largest compressed capture far below Netlify’s body cap on both routes', () => {
    const payload = `${CAPTURE_GZIP_TAG}${'A'.repeat(MAX_ENCODED_CAPTURE_CHARS - CAPTURE_GZIP_TAG.length)}`;
    const form = new URLSearchParams({ [CAPTURE_FORM_TOKEN_FIELD]: key, [CAPTURE_FORM_FIELD]: payload });
    const json = JSON.stringify({ payload, method: 'browser-capture', track: true, key });
    for (const body of [form.toString(), json]) {
      expect(body.length).toBeLessThan(MAX_ENCODED_CAPTURE_CHARS + 200);
      expect(body.length).toBeLessThan(BASE64_SAFE_BODY / 2);
    }
  });

  it('keep the worst-case plain capture below Netlify’s body cap, even base64-encoded', () => {
    const worstForm = 3 * MAX_PLAIN_CAPTURE_BYTES + ROUTE_OVERHEAD;
    const worstJson = 2 * MAX_PLAIN_CAPTURE_BYTES + ROUTE_OVERHEAD;
    expect(Math.max(worstForm, worstJson)).toBeLessThanOrEqual(BASE64_SAFE_BODY);
    // Percent-encoding really is at most 3 bytes per UTF-8 byte.
    const nasty = '"%&+='.repeat(MAX_PLAIN_CAPTURE_BYTES / 5);
    expect(new URLSearchParams({ [CAPTURE_FORM_FIELD]: nasty }).toString().length).toBeLessThanOrEqual(
      3 * MAX_PLAIN_CAPTURE_BYTES + CAPTURE_FORM_FIELD.length + 1,
    );
  });

  it('fit the envelope limit into the encoded limit at 5.4:1 compression', () => {
    const gzipBytes = Math.floor(((MAX_ENCODED_CAPTURE_CHARS - CAPTURE_GZIP_TAG.length) * 3) / 4);
    expect(MAX_DECODED_CAPTURE_BYTES / gzipBytes).toBeLessThan(5.4);
  });
});
