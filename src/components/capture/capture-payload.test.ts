import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  brokenCompressionStream,
  envelopeJson,
  gzipPayload,
  incompressibleJson,
  UNICODE_SAMPLE,
} from '@tests/support/capture-codec';

import { decodeCapturePayload } from '@/integrations/moxfield/capture-codec';
import {
  CAPTURE_GZIP_TAG,
  MAX_DECODED_CAPTURE_BYTES,
  MAX_ENCODED_CAPTURE_CHARS,
  MAX_PLAIN_CAPTURE_BYTES,
} from '@/integrations/moxfield/capture-codec-protocol';

import {
  CAPTURE_TOO_LARGE_COMPRESSED_MESSAGE,
  CAPTURE_TOO_LARGE_MESSAGE,
  CAPTURE_TOO_LARGE_UNCOMPRESSED_MESSAGE,
  inflateCapturePayload,
  prepareCapturePayload,
} from './capture-payload';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prepareCapturePayload', () => {
  it('compresses JSON so that the server decodes the exact text', async () => {
    for (const text of [envelopeJson(), JSON.stringify({ deck: envelopeJson(), primer: UNICODE_SAMPLE })]) {
      const prepared = await prepareCapturePayload(text);
      if (!prepared.ok) throw new Error(prepared.message);
      expect(prepared.payload.startsWith(CAPTURE_GZIP_TAG)).toBe(true);
      expect(prepared.payload.length).toBeLessThan(text.length);
      await expect(decodeCapturePayload(prepared.payload)).resolves.toBe(text);
    }
  });

  it('sends a payload the bookmarklet already compressed as it is', async () => {
    const payload = gzipPayload(envelopeJson());
    expect(await prepareCapturePayload(payload)).toEqual({ ok: true, payload });
  });

  it('sends plain JSON in a browser without CompressionStream, or when compressing fails', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    expect(await prepareCapturePayload(envelopeJson())).toEqual({ ok: true, payload: envelopeJson() });

    vi.stubGlobal('CompressionStream', brokenCompressionStream);
    expect(await prepareCapturePayload(envelopeJson())).toEqual({ ok: true, payload: envelopeJson() });
  });

  it('refuses text over the limit of what git-moxfield accepts, before compressing it', async () => {
    const compress = vi.fn();
    vi.stubGlobal('CompressionStream', compress);
    expect(await prepareCapturePayload(' '.repeat(MAX_DECODED_CAPTURE_BYTES + 1))).toEqual({
      ok: false,
      message: CAPTURE_TOO_LARGE_MESSAGE,
    });
    expect(compress).not.toHaveBeenCalled();
    expect(CAPTURE_TOO_LARGE_MESSAGE).toBe('The deck data is too large to import (limit 8.0 MB).');
  });

  it('refuses a payload that stays over the compressed limit', async () => {
    const tooLarge = CAPTURE_GZIP_TAG + 'A'.repeat(MAX_ENCODED_CAPTURE_CHARS);
    expect(await prepareCapturePayload(tooLarge)).toEqual({
      ok: false,
      message: CAPTURE_TOO_LARGE_COMPRESSED_MESSAGE,
    });
    // Noise that gzip cannot shrink below the compressed limit.
    const noise = incompressibleJson(2_200_000);
    expect(noise.length).toBeLessThan(MAX_DECODED_CAPTURE_BYTES);
    expect(await prepareCapturePayload(noise)).toEqual({
      ok: false,
      message: CAPTURE_TOO_LARGE_COMPRESSED_MESSAGE,
    });
  });

  it('refuses plain JSON over the uncompressed limit in a browser that cannot compress', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    const text = JSON.stringify({ padding: ' '.repeat(MAX_PLAIN_CAPTURE_BYTES) });
    expect(await prepareCapturePayload(text)).toEqual({
      ok: false,
      message: CAPTURE_TOO_LARGE_UNCOMPRESSED_MESSAGE,
    });
    expect(CAPTURE_TOO_LARGE_UNCOMPRESSED_MESSAGE).toContain('(limit 1.4 MB)');
  });
});

describe('inflateCapturePayload', () => {
  it('inflates a compressed payload to the exact text, ignoring surrounding whitespace', async () => {
    for (const text of [envelopeJson(), UNICODE_SAMPLE, '']) {
      expect(await inflateCapturePayload(`\n ${gzipPayload(text)} \n`)).toEqual({ ok: true, text });
    }
  });

  it('returns plain text unchanged', async () => {
    expect(await inflateCapturePayload(envelopeJson())).toEqual({ ok: true, text: envelopeJson() });
  });

  it('stops inflating past the limit (a decompression bomb)', async () => {
    const bomb = gzipPayload(' '.repeat(10_000));
    expect(await inflateCapturePayload(bomb, 9_999)).toEqual({ ok: false, reason: 'too-large' });
    expect(await inflateCapturePayload(bomb, 10_000)).toEqual({ ok: true, text: ' '.repeat(10_000) });
    expect(await inflateCapturePayload(CAPTURE_GZIP_TAG + 'A'.repeat(MAX_ENCODED_CAPTURE_CHARS))).toEqual({
      ok: false,
      reason: 'too-large',
    });
  });

  it.each([
    ['not base64url', `${CAPTURE_GZIP_TAG}not+base64/url=`],
    ['an impossible base64url length', `${CAPTURE_GZIP_TAG}AAAAA`],
    ['not gzip', `${CAPTURE_GZIP_TAG}${Buffer.from(envelopeJson()).toString('base64url')}`],
    ['cut off', CAPTURE_GZIP_TAG + gzipSync(envelopeJson()).subarray(0, -10).toString('base64url')],
    ['not UTF-8', gzipPayload(new Uint8Array([0x7b, 0xff, 0x7d]))],
  ])('reports a payload that is %s as malformed', async (_case, payload) => {
    expect(await inflateCapturePayload(payload)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('reports an unknown encoding', async () => {
    expect(await inflateCapturePayload('gm-brotli-base64url:AAAA')).toEqual({
      ok: false,
      reason: 'unsupported-encoding',
    });
  });

  it('reports a browser without DecompressionStream', async () => {
    vi.stubGlobal('DecompressionStream', undefined);
    expect(await inflateCapturePayload(gzipPayload(envelopeJson()))).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });
});
