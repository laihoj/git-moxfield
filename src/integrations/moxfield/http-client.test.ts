import { describe, expect, it, vi } from 'vitest';

import { DeckSourceError } from '../deck-source';

import { MoxfieldHttpClient, parseRetryAfter, type MoxfieldHttpClientOptions } from './http-client';
import { cloudflareBlockResponse, fakeFetch, jsonResponse, v1Primer, v3Deck } from './test-fixtures';

const DECK_ID = 'FixtureDeckId_00000001';
const DECK_URL = `https://api2.moxfield.com/v3/decks/all/${DECK_ID}`;
const START = Date.parse('2026-10-09T12:00:00.000Z');

function setup(handler: Parameters<typeof fakeFetch>[0], overrides: Partial<MoxfieldHttpClientOptions> = {}) {
  let now = START;
  const sleeps: number[] = [];
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const fetchImpl = fakeFetch(handler);
  const client = new MoxfieldHttpClient({
    apiBaseUrl: 'https://api2.moxfield.com',
    timeoutMs: 5_000,
    minRequestIntervalMs: 1_000,
    blockBackoffSeconds: 3_600,
    fetchImpl,
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    logger,
    ...overrides,
  });
  return {
    client,
    calls: fetchImpl.calls,
    sleeps,
    logger,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<DeckSourceError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DeckSourceError);
  return error as DeckSourceError;
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

describe('MoxfieldHttpClient — success', () => {
  it('fetches deck JSON with an honest User-Agent', async () => {
    const { client, calls, logger } = setup(() => jsonResponse(v3Deck()));
    await expect(client.getDeckJson(DECK_ID)).resolves.toEqual(v3Deck());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(DECK_URL);
    expect(calls[0]?.init?.method).toBe('GET');
    expect(headerOf(calls[0]?.init, 'Accept')).toBe('application/json');
    expect(headerOf(calls[0]?.init, 'User-Agent')).toBe(
      'git-moxfield/0.1 (+https://github.com/laihoj/git-moxfield)',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('sends a configured Moxfield-issued User-Agent', async () => {
    const { client, calls } = setup(() => jsonResponse({}), { userAgent: 'ApprovedProject/1.0 (issued)' });
    await client.getDeckJson(DECK_ID);
    expect(headerOf(calls[0]?.init, 'User-Agent')).toBe('ApprovedProject/1.0 (issued)');
  });

  it('fetches the primer by internal id and honors a base path', async () => {
    const { client, calls } = setup(() => jsonResponse(v1Primer()), {
      apiBaseUrl: 'http://localhost:4010/mock-moxfield/',
    });
    await expect(client.getPrimerJson('Fx001')).resolves.toEqual(v1Primer());
    expect(calls[0]?.url).toBe('http://localhost:4010/mock-moxfield/v1/decks/Fx001/primer');
  });

  it('parses JSON without a content type', async () => {
    const { client } = setup(() => new Response('{"a":1}', { status: 200, headers: { 'content-type': '' } }));
    await expect(client.getDeckJson(DECK_ID)).resolves.toEqual({ a: 1 });
  });

  it('rejects malformed ids without any request', async () => {
    const { client, calls } = setup(() => jsonResponse({}));
    expect((await failure(client.getDeckJson('../admin'))).code).toBe('invalid-ref');
    expect((await failure(client.getPrimerJson('a/b'))).code).toBe('schema');
    expect(calls).toHaveLength(0);
  });

  it('rejects non-http API base URLs', () => {
    expect(
      () =>
        new MoxfieldHttpClient({
          apiBaseUrl: 'file:///etc',
          timeoutMs: 1,
          minRequestIntervalMs: 0,
          blockBackoffSeconds: 0,
        }),
    ).toThrow(TypeError);
  });
});

describe('MoxfieldHttpClient — error mapping', () => {
  it('maps 404 to not-found without retrying', async () => {
    const { client, calls, logger } = setup(() => jsonResponse({ title: 'Not Found' }, 404));
    const error = await failure(client.getDeckJson(DECK_ID));
    expect(error).toMatchObject({ code: 'not-found', status: 404, source: 'moxfield' });
    expect(calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith('Moxfield request failed', {
      path: `/v3/decks/all/${DECK_ID}`,
      status: 404,
      code: 'not-found',
      attempt: 1,
      willRetry: false,
    });
  });

  it('maps a 403 JSON answer to forbidden', async () => {
    const { client } = setup(() => jsonResponse({ title: 'Forbidden' }, 403));
    expect(await failure(client.getDeckJson(DECK_ID))).toMatchObject({ code: 'forbidden', status: 403 });
    expect(client.blockedUntil()).toBeNull();
  });

  it('maps 401 to forbidden', async () => {
    const { client } = setup(() => new Response(null, { status: 401 }));
    expect((await failure(client.getDeckJson(DECK_ID))).code).toBe('forbidden');
  });

  it('detects a Cloudflare block, pauses requests and resumes after the backoff', async () => {
    let blocked = true;
    const { client, calls, advance } = setup(() =>
      blocked ? cloudflareBlockResponse() : jsonResponse({ ok: 1 }),
    );
    const error = await failure(client.getDeckJson(DECK_ID));
    expect(error).toMatchObject({ code: 'blocked', status: 403, retryAfterSeconds: 3_600 });
    expect(client.blockedUntil()).toBe(START + 3_600_000);
    expect(calls).toHaveLength(1);

    advance(600_000);
    const shortCircuit = await failure(client.getPrimerJson('Fx001'));
    expect(shortCircuit).toMatchObject({ code: 'blocked', retryAfterSeconds: 3_000, status: undefined });
    expect(calls).toHaveLength(1);

    blocked = false;
    advance(3_000_000);
    expect(client.blockedUntil()).toBeNull();
    await expect(client.getDeckJson(DECK_ID)).resolves.toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
  });

  it.each([
    [
      '403 cf-ray plain text',
      () =>
        new Response('error code: 1020', {
          status: 403,
          headers: { 'content-type': 'text/plain', 'cf-ray': 'x' },
        }),
    ],
    [
      'a Cloudflare challenge (cf-mitigated) at any status',
      () =>
        new Response('<!DOCTYPE html><title>Just a moment...</title>', {
          status: 503,
          headers: { 'content-type': 'text/html', 'cf-ray': 'x', 'cf-mitigated': 'Challenge' },
        }),
    ],
  ])('treats %s as a block', async (_label, response) => {
    const { client, calls } = setup(response);
    expect((await failure(client.getDeckJson(DECK_ID))).code).toBe('blocked');
    expect(client.blockedUntil()).not.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('treats a 503 HTML page behind Cloudflare as unavailable, retrying once without pausing', async () => {
    let attempts = 0;
    const { client, calls, sleeps } = setup(() =>
      ++attempts === 1 ? cloudflareBlockResponse(503) : jsonResponse({ ok: true }),
    );
    await expect(client.getDeckJson(DECK_ID)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1_000]);
    expect(client.blockedUntil()).toBeNull();
  });

  it('maps a persistent 503 HTML page to unavailable, not blocked', async () => {
    const { client, calls } = setup(() => cloudflareBlockResponse(503));
    expect(await failure(client.getDeckJson(DECK_ID))).toMatchObject({ code: 'unavailable', status: 503 });
    expect(calls).toHaveLength(2);
    expect(client.blockedUntil()).toBeNull();
    // Server fetches stay possible right away.
    await failure(client.getDeckJson(DECK_ID));
    expect(calls).toHaveLength(4);
  });

  it('waits for a short Retry-After before the single retry of a 5xx', async () => {
    let attempts = 0;
    const { client, calls, sleeps } = setup(() =>
      ++attempts === 1
        ? new Response('maintenance', { status: 503, headers: { 'retry-after': '3' } })
        : jsonResponse({ ok: true }),
    );
    await expect(client.getDeckJson(DECK_ID)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([3_000]);
  });

  it('does not retry a 5xx whose Retry-After is long, and reports it', async () => {
    const { client, calls, sleeps } = setup(
      () => new Response(null, { status: 503, headers: { 'retry-after': '120' } }),
    );
    expect(await failure(client.getDeckJson(DECK_ID))).toMatchObject({
      code: 'unavailable',
      status: 503,
      retryAfterSeconds: 120,
    });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('maps 429 with Retry-After seconds', async () => {
    const { client, calls } = setup(() => jsonResponse({}, 429, { 'retry-after': '120' }));
    expect(await failure(client.getDeckJson(DECK_ID))).toMatchObject({
      code: 'rate-limited',
      status: 429,
      retryAfterSeconds: 120,
    });
    expect(calls).toHaveLength(1);
  });

  it('maps 429 with an HTTP-date Retry-After', async () => {
    const retryAt = new Date(START + 90_500).toUTCString();
    const { client } = setup(() => new Response(null, { status: 429, headers: { 'retry-after': retryAt } }));
    expect((await failure(client.getDeckJson(DECK_ID))).retryAfterSeconds).toBe(90);
  });

  it('maps 429 without Retry-After to a default pause', async () => {
    const { client } = setup(() => new Response(null, { status: 429 }));
    const error = await failure(client.getDeckJson(DECK_ID));
    expect(error.code).toBe('rate-limited');
    expect(error.retryAfterSeconds).toBe(60);
    expect(client.rateLimitedUntil()).toBe(START + 60_000);
  });

  it('honors Retry-After: sends nothing until it has passed, for any request', async () => {
    let limited = true;
    const { client, calls, advance } = setup(() =>
      limited ? jsonResponse({}, 429, { 'retry-after': '30' }) : jsonResponse({ ok: 1 }),
    );
    expect(await failure(client.getDeckJson(DECK_ID))).toMatchObject({
      code: 'rate-limited',
      retryAfterSeconds: 30,
    });
    expect(client.rateLimitedUntil()).toBe(START + 30_000);
    expect(calls).toHaveLength(1);

    // Other decks and the primer endpoint wait too; the remaining time counts down.
    advance(11_000);
    expect(await failure(client.getDeckJson('OtherDeckId_0000000001'))).toMatchObject({
      code: 'rate-limited',
      retryAfterSeconds: 19,
      status: undefined,
    });
    expect(await failure(client.getPrimerJson('A0j00'))).toMatchObject({ code: 'rate-limited' });
    expect(calls).toHaveLength(1);
    // Not a bot-protection block: server fetching stays available.
    expect(client.blockedUntil()).toBeNull();

    advance(19_000);
    limited = false;
    expect(client.rateLimitedUntil()).toBeNull();
    await expect(client.getDeckJson(DECK_ID)).resolves.toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
  });

  it('ends block and rate-limit pauses on clearPauses', async () => {
    let answer: () => Response = () => cloudflareBlockResponse();
    const { client, calls } = setup(() => answer());
    expect((await failure(client.getDeckJson(DECK_ID))).code).toBe('blocked');
    expect(client.blockedUntil()).toBe(START + 3_600_000);
    client.clearPauses();
    expect(client.blockedUntil()).toBeNull();

    answer = () => jsonResponse({}, 429, { 'retry-after': '30' });
    expect((await failure(client.getDeckJson(DECK_ID))).code).toBe('rate-limited');
    expect(client.rateLimitedUntil()).not.toBeNull();
    client.clearPauses();
    expect(client.rateLimitedUntil()).toBeNull();

    answer = () => jsonResponse({ ok: 1 });
    await expect(client.getDeckJson(DECK_ID)).resolves.toEqual({ ok: 1 });
    expect(calls).toHaveLength(3);
  });

  it('caps an absurd Retry-After at the block backoff', async () => {
    const { client } = setup(() => jsonResponse({}, 429, { 'retry-after': '999999' }), {
      blockBackoffSeconds: 600,
    });
    expect((await failure(client.getDeckJson(DECK_ID))).retryAfterSeconds).toBe(600);
    expect(client.rateLimitedUntil()).toBe(START + 600_000);
  });

  it('retries a 5xx once after a short backoff', async () => {
    let attempts = 0;
    const { client, calls, sleeps, logger } = setup(() =>
      ++attempts === 1 ? new Response('oops', { status: 502 }) : jsonResponse({ ok: true }),
    );
    await expect(client.getDeckJson(DECK_ID)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1_000]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Moxfield request failed',
      expect.objectContaining({ status: 502, code: 'unavailable', attempt: 1, willRetry: true }),
    );
  });

  it('gives up after the retry of a 5xx', async () => {
    const { client, calls } = setup(() => new Response(null, { status: 500 }));
    expect(await failure(client.getDeckJson(DECK_ID))).toMatchObject({ code: 'unavailable', status: 500 });
    expect(calls).toHaveLength(2);
  });

  it('does not retry other 4xx answers', async () => {
    const { client, calls } = setup(() => new Response(null, { status: 400 }));
    expect(await failure(client.getDeckJson(DECK_ID))).toMatchObject({ code: 'unavailable', status: 400 });
    expect(calls).toHaveLength(1);
  });

  it('never follows redirects', async () => {
    const { client, calls } = setup(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
    );
    expect(await failure(client.getDeckJson(DECK_ID))).toMatchObject({ code: 'unavailable', status: 302 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.redirect).toBe('manual');
  });

  it('retries network errors once', async () => {
    const { client, calls } = setup(() => {
      throw new TypeError('fetch failed');
    });
    const error = await failure(client.getDeckJson(DECK_ID));
    expect(error.code).toBe('network');
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(2);
  });

  it('recovers when the retry after a network error succeeds', async () => {
    let attempts = 0;
    const { client } = setup(() => {
      if (++attempts === 1) throw new TypeError('socket hang up');
      return jsonResponse({ ok: true });
    });
    await expect(client.getDeckJson(DECK_ID)).resolves.toEqual({ ok: true });
  });

  it('times out without retrying', async () => {
    const { client, calls } = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason as Error);
          });
        }),
      { timeoutMs: 20 },
    );
    expect((await failure(client.getDeckJson(DECK_ID))).code).toBe('timeout');
    expect(calls).toHaveLength(1);
  });

  it('rejects with the caller’s abort reason', async () => {
    const controller = new AbortController();
    const { client } = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason as Error);
          });
        }),
    );
    const pending = client.getDeckJson(DECK_ID, controller.signal);
    controller.abort(new Error('navigated away'));
    await expect(pending).rejects.toThrow('navigated away');
  });

  it.each([
    [
      'HTML with status 200',
      () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ],
    [
      'invalid JSON',
      () => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    ],
    [
      'an oversized body',
      () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': '99999999' },
        }),
    ],
  ])('maps %s to schema', async (_label, response) => {
    const { client, calls } = setup(response);
    expect((await failure(client.getDeckJson(DECK_ID))).code).toBe('schema');
    expect(calls).toHaveLength(1);
  });
});

describe('MoxfieldHttpClient — pacing', () => {
  it('spaces request starts by the minimum interval', async () => {
    const { client, sleeps, advance } = setup(() => jsonResponse({}));
    await client.getDeckJson(DECK_ID);
    expect(sleeps).toEqual([]);
    await client.getPrimerJson('Fx001');
    expect(sleeps).toEqual([1_000]);
    advance(400);
    await client.getPrimerJson('Fx001');
    expect(sleeps).toEqual([1_000, 600]);
    advance(5_000);
    await client.getPrimerJson('Fx001');
    expect(sleeps).toEqual([1_000, 600]);
  });

  it('serializes concurrent requests', async () => {
    const order: string[] = [];
    const releases: (() => void)[] = [];
    const { client } = setup(
      (url) =>
        new Promise<Response>((resolve) => {
          order.push(`start ${url.slice(-6)}`);
          releases.push(() => {
            order.push(`end ${url.slice(-6)}`);
            resolve(jsonResponse({}));
          });
        }),
      { minRequestIntervalMs: 0 },
    );
    const first = client.getDeckJson(DECK_ID);
    const second = client.getPrimerJson('Fx001');
    await vi.waitFor(() => {
      expect(releases).toHaveLength(1);
    });
    releases[0]?.();
    await first;
    await vi.waitFor(() => {
      expect(releases).toHaveLength(2);
    });
    releases[1]?.();
    await second;
    expect(order).toEqual(['start 000001', 'end 000001', 'start primer', 'end primer']);
  });

  it('keeps working after a failed request in the queue', async () => {
    let attempts = 0;
    const { client } = setup(() => (++attempts === 1 ? jsonResponse({}, 404) : jsonResponse({ ok: 1 })));
    const first = client.getDeckJson(DECK_ID);
    const second = client.getDeckJson(DECK_ID);
    expect((await failure(first)).code).toBe('not-found');
    await expect(second).resolves.toEqual({ ok: 1 });
  });
});

describe('parseRetryAfter', () => {
  it.each([
    [null, undefined],
    ['', undefined],
    ['30', 30],
    [' 0 ', 0],
    ['soon', undefined],
    [new Date(START + 10_000).toUTCString(), 10],
    [new Date(START - 10_000).toUTCString(), 0],
  ])('%j → %j', (value, expected) => {
    expect(parseRetryAfter(value, START)).toBe(expected);
  });
});
