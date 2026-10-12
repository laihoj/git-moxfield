import { describe, expect, it, vi } from 'vitest';

import { expectRejection } from '@tests/support/errors';
import { FakeMoxfieldLimiter } from '@tests/support/request-limiter';

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
  const limiter = new FakeMoxfieldLimiter();
  const client = new MoxfieldHttpClient({
    apiBaseUrl: 'https://api2.moxfield.com',
    timeoutMs: 5_000,
    limiter,
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
  return { client, calls: fetchImpl.calls, sleeps, logger, limiter };
}

function failure(promise: Promise<unknown>): Promise<DeckSourceError> {
  return expectRejection(promise, DeckSourceError);
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
          limiter: new FakeMoxfieldLimiter(),
        }),
    ).toThrow(TypeError);
  });
});

describe('MoxfieldHttpClient — error mapping', () => {
  it('refuses a response over the size limit even when its length is not announced', async () => {
    const chunk = new Uint8Array(1_000_000);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 40) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const { client } = setup(
      () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const error = await failure(client.getDeckJson(DECK_ID));
    expect(error).toMatchObject({ code: 'schema', message: 'The Moxfield response is too large.' });
    // Reading stopped soon after the limit; the rest of the body was never buffered.
    expect(pulls).toBeLessThan(25);
  });

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

  it('pauses server fetching on any 403, also a JSON one: a refusal may start a ban', async () => {
    const { client, calls, limiter } = setup(() => jsonResponse({ title: 'Forbidden' }, 403));
    expect(await failure(client.getDeckJson(DECK_ID))).toMatchObject({
      code: 'blocked',
      status: 403,
      message: expect.stringContaining('until an admin resumes it') as unknown,
    });
    expect(limiter.blocks).toEqual([`Moxfield refused a request (HTTP 403) for /v3/decks/all/${DECK_ID}.`]);
    // The limiter refuses everything after that, so nothing more is sent.
    expect((await failure(client.getPrimerJson('Fx001'))).code).toBe('blocked');
    expect(calls).toHaveLength(1);
  });

  it('maps 401 to forbidden without pausing', async () => {
    const { client, limiter } = setup(() => new Response(null, { status: 401 }));
    expect((await failure(client.getDeckJson(DECK_ID))).code).toBe('forbidden');
    expect(limiter.blocks).toEqual([]);
  });

  it('detects a Cloudflare block, pauses every request until resumed', async () => {
    let blocked = true;
    const { client, calls, limiter } = setup(() =>
      blocked ? cloudflareBlockResponse() : jsonResponse({ ok: 1 }),
    );
    const error = await failure(client.getDeckJson(DECK_ID));
    expect(error).toMatchObject({ code: 'blocked', status: 403, retryAfterSeconds: undefined });
    expect(limiter.blocks).toEqual(["Moxfield's bot protection answered a request (HTTP 403, text/html)."]);
    expect(calls).toHaveLength(1);

    expect(await failure(client.getPrimerJson('Fx001'))).toMatchObject({
      code: 'blocked',
      status: undefined,
    });
    expect(calls).toHaveLength(1);

    blocked = false;
    await limiter.resume();
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
    [
      'a Cloudflare challenge answered with 200',
      () =>
        new Response('<!DOCTYPE html>', {
          status: 200,
          headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
        }),
    ],
    [
      'an HTML page answered with 200 (never the API)',
      () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ],
  ])('treats %s as a block', async (_label, response) => {
    const { client, calls, limiter } = setup(response);
    expect((await failure(client.getDeckJson(DECK_ID))).code).toBe('blocked');
    expect(limiter.blocks).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('treats a 503 HTML page behind Cloudflare as unavailable, retrying once without pausing', async () => {
    let attempts = 0;
    const { client, calls, sleeps, limiter } = setup(() =>
      ++attempts === 1 ? cloudflareBlockResponse(503) : jsonResponse({ ok: true }),
    );
    await expect(client.getDeckJson(DECK_ID)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1_000]);
    expect(limiter.blocks).toEqual([]);
  });

  it('maps a persistent 503 HTML page to unavailable, not blocked', async () => {
    const { client, calls, limiter } = setup(() => cloudflareBlockResponse(503));
    expect(await failure(client.getDeckJson(DECK_ID))).toMatchObject({ code: 'unavailable', status: 503 });
    expect(calls).toHaveLength(2);
    expect(limiter.blocks).toEqual([]);
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

  it('reports a 429 with Retry-After seconds to the limiter, which slows every instance down', async () => {
    const { client, calls, limiter } = setup(() => jsonResponse({}, 429, { 'retry-after': '120' }));
    expect(await failure(client.getDeckJson(DECK_ID))).toMatchObject({
      code: 'rate-limited',
      status: 429,
      retryAfterSeconds: 120,
      message: expect.stringContaining('slow down (HTTP 429)') as unknown,
    });
    expect(limiter.rateLimits).toEqual([120]);
    expect(limiter.blocks).toEqual([]);
    // Never retried: the limiter decides when the next request goes out.
    expect(calls).toHaveLength(1);
  });

  it('reports an HTTP-date Retry-After in seconds', async () => {
    const retryAt = new Date(START + 90_500).toUTCString();
    const { client, limiter } = setup(
      () => new Response(null, { status: 429, headers: { 'retry-after': retryAt } }),
    );
    expect((await failure(client.getDeckJson(DECK_ID))).retryAfterSeconds).toBe(90);
    expect(limiter.rateLimits).toEqual([90]);
  });

  it('leaves the pause after a 429 without Retry-After to the limiter (exponential backoff)', async () => {
    const { client, limiter } = setup(() => new Response(null, { status: 429 }));
    const error = await failure(client.getDeckJson(DECK_ID));
    expect(error).toMatchObject({ code: 'rate-limited', retryAfterSeconds: 30 });
    expect(limiter.rateLimits).toEqual([undefined]);
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
    [
      'plain text with status 200',
      () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }),
    ],
  ])('maps %s to schema', async (_label, response) => {
    const { client, calls } = setup(response);
    expect((await failure(client.getDeckJson(DECK_ID))).code).toBe('schema');
    expect(calls).toHaveLength(1);
  });
});

describe('MoxfieldHttpClient — request limiter', () => {
  it('asks the limiter before every request it sends, retries included', async () => {
    let attempts = 0;
    const { client, calls, limiter } = setup(() =>
      ++attempts === 1 ? new Response(null, { status: 502 }) : jsonResponse({ ok: true }),
    );
    await client.getDeckJson(DECK_ID);
    await client.getPrimerJson('Fx001');
    expect(calls).toHaveLength(3);
    expect(limiter.admitted).toBe(3);
  });

  it('sends nothing when the limiter refuses (fails closed)', async () => {
    const { client, calls, limiter } = setup(() => jsonResponse({}));
    limiter.refuseWith = new DeckSourceError('unavailable', 'database unavailable', { source: 'moxfield' });
    expect(await failure(client.getDeckJson(DECK_ID))).toMatchObject({
      code: 'unavailable',
      message: 'database unavailable',
    });
    expect(await failure(client.getPrimerJson('Fx001'))).toMatchObject({ code: 'unavailable' });
    expect(calls).toHaveLength(0);
  });

  it('never logs the User-Agent or puts it in an error', async () => {
    const userAgent = 'ApprovedProject/1.0 (secret-token-xyz)';
    let attempt = 0;
    const answers: (() => Response)[] = [
      () => new Response(null, { status: 502 }),
      () => jsonResponse({ ok: 1 }),
      () => jsonResponse({}, 429, { 'retry-after': '5' }),
    ];
    const { client, logger, limiter } = setup(() => (answers[attempt++] ?? cloudflareBlockResponse)(), {
      userAgent,
    });
    await client.getDeckJson(DECK_ID);
    const errors = [await failure(client.getDeckJson(DECK_ID)), await failure(client.getDeckJson(DECK_ID))];
    const logged = JSON.stringify([
      logger.debug.mock.calls,
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
    ]);
    expect(logged).toContain('Moxfield request failed');
    expect(logged).not.toContain('secret-token-xyz');
    for (const error of errors) {
      expect(error.message).not.toContain('secret');
      expect(JSON.stringify(error)).not.toContain('secret');
    }
    expect(JSON.stringify(limiter.blocks)).not.toContain('secret');
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
