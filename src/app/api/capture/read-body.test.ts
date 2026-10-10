import { describe, expect, it } from 'vitest';

import {
  CAPTURE_GZIP_TAG,
  MAX_ENCODED_CAPTURE_CHARS,
  MAX_PLAIN_CAPTURE_BYTES,
} from '@/integrations/moxfield/capture-codec-protocol';
import { CAPTURE_FORM_FIELD, CAPTURE_FORM_TOKEN_FIELD } from '@/integrations/moxfield/capture-protocol';
import { PROXY_BODY_BUFFER_LIMIT } from '@/server/proxy-body-limit';

import {
  CAPTURE_FORM_BODY_LIMIT,
  CAPTURE_JSON_BODY_LIMIT,
  declaredTooLarge,
  readBodyLimited,
} from './read-body';

/**
 * Next truncates a body at the proxy buffer, dropping the chunk that crosses it, so a
 * truncated body can be up to one chunk shorter than the buffer. A route limit needs at
 * least this much room below the buffer for a truncated body to still be too large.
 */
const TRUNCATION_HEADROOM = 1024 * 1024;

/** Netlify's cap on a function's request payload (ADR 0008). */
const NETLIFY_MAX_PAYLOAD_BYTES = 6_000_000;

/** Size of `bytes` bytes once base64-encoded, as the platform may hand a body to the function. */
function base64Size(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/** The worst case: a plain payload whose every character JSON escapes (`"` becomes `\"`). */
const WORST_PLAIN_JSON = '"'.repeat(MAX_PLAIN_CAPTURE_BYTES);

/** The largest compressed payload the decoder accepts (its data need not be valid here). */
const LARGEST_ENCODED = CAPTURE_GZIP_TAG + 'A'.repeat(MAX_ENCODED_CAPTURE_CHARS - CAPTURE_GZIP_TAG.length);

/** A key-shaped value as long as a bookmarklet key. */
const KEY = `gmk_${'k'.repeat(43)}`;

describe('capture body limits', () => {
  it('have the values the hosting limits were checked against', () => {
    expect(CAPTURE_JSON_BODY_LIMIT).toBe(2_865_536);
    expect(CAPTURE_FORM_BODY_LIMIT).toBe(4_265_536);
  });

  it.each([
    ['JSON', CAPTURE_JSON_BODY_LIMIT],
    ['form', CAPTURE_FORM_BODY_LIMIT],
  ])('the %s route limit fits Netlify, even base64-encoded, and the proxy buffer', (_route, limit) => {
    expect(base64Size(limit)).toBeLessThan(NETLIFY_MAX_PAYLOAD_BYTES);
    expect(limit).toBeLessThanOrEqual(PROXY_BODY_BUFFER_LIMIT - TRUNCATION_HEADROOM);
  });

  it('the JSON route accepts the largest compressed and the worst plain payload', () => {
    for (const payload of [LARGEST_ENCODED, WORST_PLAIN_JSON]) {
      const body = JSON.stringify({ payload, method: 'browser-capture', track: false, key: KEY });
      expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(CAPTURE_JSON_BODY_LIMIT);
    }
    expect(JSON.stringify(WORST_PLAIN_JSON).length).toBeGreaterThan(2 * MAX_PLAIN_CAPTURE_BYTES);
  });

  it('the form route accepts the largest compressed and the worst plain payload', () => {
    // Every character of this plain payload is percent-encoded (three bytes).
    const worstPlain = '{'.repeat(MAX_PLAIN_CAPTURE_BYTES);
    for (const payload of [LARGEST_ENCODED, worstPlain]) {
      const body = new URLSearchParams({ [CAPTURE_FORM_TOKEN_FIELD]: KEY, [CAPTURE_FORM_FIELD]: payload });
      expect(body.toString().length).toBeLessThanOrEqual(CAPTURE_FORM_BODY_LIMIT);
    }
    // `p=` is 2 bytes; the tag's `:` becomes `%3A`, 2 more.
    expect(new URLSearchParams({ p: LARGEST_ENCODED }).toString().length).toBe(
      MAX_ENCODED_CAPTURE_CHARS + 2 + 2,
    );
    expect(new URLSearchParams({ p: worstPlain }).toString().length).toBe(3 * MAX_PLAIN_CAPTURE_BYTES + 2);
  });
});

function streamedRequest(chunks: number[]): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of chunks) controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
  return new Request('http://localhost/', { method: 'POST', body, duplex: 'half' } as RequestInit);
}

describe('readBodyLimited', () => {
  it('reads a body up to the limit', async () => {
    const result = await readBodyLimited(streamedRequest([3, 4]), 7);
    expect(result).toEqual({ ok: true, bytes: new Uint8Array(7) });
  });

  it('gives up as soon as the body exceeds the limit', async () => {
    expect(await readBodyLimited(streamedRequest([4, 4]), 7)).toEqual({ ok: false, reason: 'too-large' });
  });
});

describe('declaredTooLarge', () => {
  it.each([
    [null, false],
    ['7', false],
    ['8', true],
    ['nonsense', false],
  ])('Content-Length %j → %j', (length, expected) => {
    const headers = new Headers(length === null ? {} : { 'content-length': length });
    expect(declaredTooLarge(headers, 7)).toBe(expected);
  });
});
