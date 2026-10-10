import { afterEach, describe, expect, it, vi } from 'vitest';

import { postCapture } from './capture-api';

const KEY = `gmk_${'a'.repeat(43)}`;

function respond(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>): unknown {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  if (typeof init?.body !== 'string') throw new Error('No JSON body was sent');
  return JSON.parse(init.body) as unknown;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('postCapture', () => {
  it('posts the bookmarklet key with the deck (protocol v2)', async () => {
    const fetchMock = respond(200, {
      status: 'untracked',
      source: 'moxfield',
      name: 'Blue Farm',
      externalId: 'abc',
      decks: [],
    });
    const result = await postCapture('{"kind":"git-moxfield/capture"}', 'browser-capture', {
      track: false,
      key: KEY,
    });
    expect(result).toEqual({
      ok: true,
      outcome: { status: 'untracked', source: 'moxfield', name: 'Blue Farm', externalId: 'abc', decks: [] },
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/capture', expect.objectContaining({ method: 'POST' }));
    expect(sentBody(fetchMock)).toEqual({
      payload: '{"kind":"git-moxfield/capture"}',
      method: 'browser-capture',
      track: false,
      key: KEY,
    });
  });

  it('sends no key for a pasted deck', async () => {
    const fetchMock = respond(200, {
      status: 'ingested',
      deckId: 'deck-1',
      changedSinceLastObservation: true,
    });
    await postCapture({ deck: '{}', primer: '{}' }, 'manual-paste', { track: true });
    expect(sentBody(fetchMock)).toEqual({
      payload: { deck: '{}', primer: '{}' },
      method: 'manual-paste',
      track: true,
    });
  });

  it('asks to continue one of the user’s decks with the captured deck', async () => {
    const fetchMock = respond(200, {
      status: 'ingested',
      deckId: 'deck-1',
      changedSinceLastObservation: false,
    });
    const result = await postCapture('gm-gzip-base64url:abc', 'browser-capture', {
      track: false,
      relinkDeckId: 'deck-1',
      key: KEY,
    });
    expect(result).toEqual({
      ok: true,
      outcome: { status: 'ingested', deckId: 'deck-1', changedSinceLastObservation: false },
    });
    expect(sentBody(fetchMock)).toEqual({
      payload: 'gm-gzip-base64url:abc',
      method: 'browser-capture',
      track: false,
      relinkDeckId: 'deck-1',
      key: KEY,
    });
  });

  it('reads the decks an untracked deck could continue, dropping malformed entries', async () => {
    const lost = {
      id: 'deck-1',
      name: 'Lost deck',
      externalId: 'OldPublicId',
      format: 'commander',
      versionCount: 3,
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    respond(200, {
      status: 'untracked',
      source: 'moxfield',
      name: 'Lost deck',
      externalId: 'NewPublicId',
      decks: [lost, { id: 'deck-2', name: 7 }, null],
    });
    expect(await postCapture('{}', 'browser-capture', { track: false })).toEqual({
      ok: true,
      outcome: {
        status: 'untracked',
        source: 'moxfield',
        name: 'Lost deck',
        externalId: 'NewPublicId',
        decks: [lost],
      },
    });
  });

  it('refuses an answer that is not a capture outcome', async () => {
    respond(200, { status: 'ingested', deckId: 42 });
    expect(await postCapture('{}', 'browser-capture', { track: false })).toEqual({
      ok: false,
      message: 'git-moxfield could not import the deck (HTTP 200).',
    });
  });

  it.each(['unauthenticated', 'invalid-key'] as const)(
    'passes on the 401 code %s with the message',
    async (code) => {
      respond(401, { error: 'Nope.', code });
      expect(await postCapture('{}', 'browser-capture', { track: false, key: KEY })).toEqual({
        ok: false,
        message: 'Nope.',
        code,
      });
    },
  );

  it('ignores codes on other statuses and unknown codes', async () => {
    respond(400, { error: 'Bad deck.', code: 'invalid-key' });
    expect(await postCapture('{}', 'manual-paste', { track: false })).toEqual({
      ok: false,
      message: 'Bad deck.',
    });
    respond(401, { error: 'Nope.', code: 'something-else' });
    expect(await postCapture('{}', 'manual-paste', { track: false })).toEqual({
      ok: false,
      message: 'Nope.',
    });
  });

  it('reports a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const result = await postCapture('{}', 'manual-paste', { track: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Could not reach git-moxfield');
  });
});
