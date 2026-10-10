import { describe, expect, it } from 'vitest';

import { MAX_CAPTURE_BYTES } from '@/integrations/moxfield/capture-protocol';
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

describe('capture body limits', () => {
  it.each([
    ['JSON', CAPTURE_JSON_BODY_LIMIT, 2],
    ['form', CAPTURE_FORM_BODY_LIMIT, 3],
  ])(
    'the %s route accepts every encoded envelope and stays below the proxy buffer',
    (_route, limit, factor) => {
      expect(limit).toBeGreaterThan(factor * MAX_CAPTURE_BYTES);
      expect(limit).toBeLessThanOrEqual(PROXY_BODY_BUFFER_LIMIT - TRUNCATION_HEADROOM);
    },
  );
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
