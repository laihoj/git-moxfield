/**
 * `POST /api/capture` (the popup bookmarklet's capture page and the paste form) against
 * the real auth and deck services on an in-memory database: a bookmarklet key signs the
 * browser in and decides the workspace; without one the session cookie does; neither is
 * a 401. Compressed payloads are decoded within hard limits, after authentication. Keys
 * and tokens never reach the logs.
 */
import { gzipSync } from 'node:zlib';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CAPTURE_GZIP_TAG,
  encodeCapturePayload,
  MAX_DECODED_CAPTURE_BYTES,
  MAX_PLAIN_CAPTURE_BYTES,
} from '@/integrations/moxfield/capture-codec-protocol';

import { formatBytes } from '@/core/text';
import type * as AccessModule from '@/server/access';
import type * as AuthModule from '@/server/auth';
import type { SessionUser, SignIn } from '@/server/auth/types';
import type * as ConfigModule from '@/server/config';
import type { AppConfig } from '@/server/config';
import { createKey, signUp } from '@tests/support/auth';
import { gzipPayload } from '@tests/support/capture-codec';
import { buildCaptureEnvelope } from '@tests/support/moxfield-deck-builder';
import type { LogEntry } from '@tests/support/recording-logger';
import { currentHarness, setUpRouteHarness } from '@tests/support/route-harness';
import { appRequest, setCookies } from '@tests/support/routes';
import { blueFarmSpec, type ServiceHarness } from '@tests/support/services';

const state = vi.hoisted(() => ({
  harness: undefined as ServiceHarness | undefined,
  logs: [] as LogEntry[],
}));

const harness = (): ServiceHarness => currentHarness(state);

vi.mock('@/server/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  getAuthService: () => Promise.resolve(harness().auth),
}));
vi.mock('@/server/access', async (importOriginal) => ({
  ...(await importOriginal<typeof AccessModule>()),
  servicesFor: (user: SessionUser) => Promise.resolve(harness().servicesForWorkspace(user.workspaceId)),
}));
vi.mock('@/server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigModule>()),
  getConfig: (): AppConfig => harness().config,
}));
vi.mock('@/server/logger', async () =>
  (await import('@tests/support/recording-logger')).recordingLoggerModule(state.logs),
);

const { POST } = await import('@/app/api/capture/route');

const ORIGIN = 'http://localhost:3000';

let owner: SignIn;
let key: string;

setUpRouteHarness(state, { fakeDate: true });

beforeEach(async () => {
  owner = await signUp(harness().auth, 'Mikko');
  key = await createKey(harness().auth, owner.user, { appUrl: ORIGIN });
});

function capture(
  body: Record<string, unknown>,
  options: { cookie?: string; origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'Firefox' };
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
  return POST(
    appRequest('/api/capture', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(options.cookie === undefined ? {} : { cookies: { '__Host-gm_session': options.cookie } }),
    }),
  );
}

const envelope = () => JSON.stringify(buildCaptureEnvelope(blueFarmSpec()));

async function decksOf(user: SessionUser): Promise<string[]> {
  return (await harness().servicesForWorkspace(user.workspaceId).listDecks()).map((deck) => deck.name);
}

describe('POST /api/capture with a bookmarklet key', () => {
  it('captures into the key owner’s workspace and signs the browser in', async () => {
    const response = await capture({ payload: envelope(), method: 'browser-capture', track: true, key });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ingested', changedSinceLastObservation: true });
    expect(await decksOf(owner.user)).toEqual(['Blue Farm']);

    const cookie = setCookies(response).get('__Host-gm_session');
    expect(cookie?.value).toMatch(/^gms_[A-Za-z0-9_-]{43}$/);
    expect(cookie?.attributes).toMatchObject({ path: '/', httponly: true, samesite: 'Lax', secure: true });
    expect(Number(cookie?.attributes['max-age'])).toBe(400 * 86_400);
    expect((await harness().auth.resolveSession(cookie?.value))?.id).toBe(owner.user.id);
    expect(JSON.stringify(state.logs)).not.toContain(key);
  });

  it('asks before tracking an unknown deck, still signing the browser in', async () => {
    const response = await capture({ payload: envelope(), method: 'browser-capture', track: false, key });
    expect(await response.json()).toMatchObject({ status: 'untracked', name: 'Blue Farm' });
    expect(setCookies(response).has('__Host-gm_session')).toBe(true);
    expect(await decksOf(owner.user)).toEqual([]);
  });

  it('keeps the browser’s session of the same user', async () => {
    const response = await capture(
      { payload: envelope(), method: 'browser-capture', track: true, key },
      { cookie: owner.session.token },
    );
    expect(setCookies(response).get('__Host-gm_session')?.value).toBe(owner.session.token);
    expect(await harness().auth.listSessions(owner.user)).toHaveLength(1);
  });

  it('switches a browser signed in as someone else, and ends that session', async () => {
    const anna = await signUp(harness().auth, 'Anna');
    const response = await capture(
      { payload: envelope(), method: 'browser-capture', track: true, key },
      { cookie: anna.session.token },
    );
    const token = setCookies(response).get('__Host-gm_session')?.value;
    expect((await harness().auth.resolveSession(token))?.id).toBe(owner.user.id);
    expect(await harness().auth.resolveSession(anna.session.token)).toBeNull();
    expect(await decksOf(owner.user)).toEqual(['Blue Farm']);
    expect(await decksOf(anna.user)).toEqual([]);
  });

  it.each([
    ['unknown', `gmk_${'Q'.repeat(43)}`, 'unknown'],
    ['malformed', 'not-a-key', 'malformed'],
  ])('rejects an %s key with 401, even with a valid session', async (_case, badKey, logged) => {
    const response = await capture(
      { payload: envelope(), method: 'browser-capture', track: true, key: badKey },
      { cookie: owner.session.token },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'invalid-key' });
    expect(setCookies(response).size).toBe(0);
    expect(await decksOf(owner.user)).toEqual([]);
    expect(state.logs).toContainEqual(expect.objectContaining({ level: 'warn', context: { key: logged } }));
    expect(JSON.stringify(state.logs)).not.toContain(badKey);
  });

  it('rejects a revoked key', async () => {
    const [created] = await harness().auth.listKeys(owner.user);
    await harness().auth.revokeKey(owner.user, created?.id ?? '');
    const response = await capture({ payload: envelope(), method: 'browser-capture', track: true, key });
    expect(response.status).toBe(401);
  });

  it('signs the browser in even when the deck data is unusable', async () => {
    const response = await capture({ payload: '{"nope":1}', method: 'browser-capture', track: true, key });
    expect(response.status).toBe(400);
    expect(setCookies(response).has('__Host-gm_session')).toBe(true);
  });
});

describe('POST /api/capture with a session', () => {
  it('captures into the signed-in user’s workspace without setting a cookie', async () => {
    const response = await capture(
      { payload: envelope(), method: 'manual-paste', track: true },
      { cookie: owner.session.token },
    );
    expect(response.status).toBe(200);
    expect(setCookies(response).size).toBe(0);
    expect(await decksOf(owner.user)).toEqual(['Blue Farm']);
  });

  it.each([
    ['no session', undefined],
    ['a malformed cookie', 'garbage'],
    ['an ended session', 'ended'],
  ])('answers 401 with %s', async (_case, cookie) => {
    let token = cookie;
    if (cookie === 'ended') {
      await harness().auth.endSession(owner.session.token);
      token = owner.session.token;
    }
    const response = await capture(
      { payload: envelope(), method: 'manual-paste', track: true },
      token === undefined ? {} : { cookie: token },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'unauthenticated' });
    expect(await decksOf(owner.user)).toEqual([]);
  });

  it('refuses cross-origin requests before anything else', async () => {
    const response = await capture(
      { payload: envelope(), method: 'browser-capture', track: true, key },
      { origin: 'https://evil.example', cookie: owner.session.token },
    );
    expect(response.status).toBe(403);
    expect(setCookies(response).size).toBe(0);
    expect(await harness().auth.listKeys(owner.user)).toEqual([
      expect.objectContaining({ lastUsedAt: null }),
    ]);
  });
});

describe('POST /api/capture with compressed payloads', () => {
  it('decodes a payload compressed by the capture page and ingests the deck', async () => {
    const payload = await encodeCapturePayload(envelope());
    expect(payload.startsWith(CAPTURE_GZIP_TAG)).toBe(true);
    expect(payload.length).toBeLessThan(envelope().length / 2);

    const response = await capture({ payload, method: 'browser-capture', track: true, key });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ingested', changedSinceLastObservation: true });
    expect(await decksOf(owner.user)).toEqual(['Blue Farm']);
  });

  it('decodes a compressed paste of { deck, primer } JSON strings', async () => {
    const parsed = buildCaptureEnvelope(blueFarmSpec());
    const text = JSON.stringify({ deck: JSON.stringify(parsed.deck), primer: JSON.stringify(parsed.primer) });
    const response = await capture(
      { payload: gzipPayload(text), method: 'manual-paste', track: false },
      { cookie: owner.session.token },
    );
    expect(await response.json()).toMatchObject({ status: 'untracked', name: 'Blue Farm' });
  });

  it('passes plain JSON through, and still accepts an object payload as it is', async () => {
    const parsed = buildCaptureEnvelope(blueFarmSpec());
    const plain = await capture(
      { payload: ` \n${envelope()}\n`, method: 'manual-paste', track: false },
      { cookie: owner.session.token },
    );
    expect(await plain.json()).toMatchObject({ status: 'untracked', name: 'Blue Farm' });
    const object = await capture(
      { payload: { deck: JSON.stringify(parsed.deck) }, method: 'manual-paste', track: false },
      { cookie: owner.session.token },
    );
    expect(await object.json()).toMatchObject({ status: 'untracked', name: 'Blue Farm' });
  });

  it('answers 413 to a decompression bomb, still signing the browser in', async () => {
    const bomb = gzipPayload(' '.repeat(MAX_DECODED_CAPTURE_BYTES + 1));
    expect(bomb.length).toBeLessThan(20_000);

    const response = await capture({ payload: bomb, method: 'browser-capture', track: true, key });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: `The deck data is too large (limit ${formatBytes(MAX_DECODED_CAPTURE_BYTES)} uncompressed).`,
    });
    expect(setCookies(response).has('__Host-gm_session')).toBe(true);
    expect(await decksOf(owner.user)).toEqual([]);
  });

  it('answers 413 to a plain payload over the uncompressed limit', async () => {
    const response = await capture(
      { payload: `${envelope()}${' '.repeat(MAX_PLAIN_CAPTURE_BYTES)}`, method: 'manual-paste', track: true },
      { cookie: owner.session.token },
    );
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: string }).error).toContain('too large to send uncompressed');
  });

  it.each([
    ['not base64url', `${CAPTURE_GZIP_TAG}not+base64/url=`, 'not valid base64url'],
    ['not gzip', `${CAPTURE_GZIP_TAG}${Buffer.from(envelope()).toString('base64url')}`, 'not valid gzip'],
    [
      'cut off',
      CAPTURE_GZIP_TAG + gzipSync(envelope()).subarray(0, -10).toString('base64url'),
      'not valid gzip',
    ],
    ['in an unknown encoding', 'gm-brotli-base64url:AAAA', 'does not support'],
  ])('answers 400 to a compressed payload that is %s', async (_case, payload, fragment) => {
    const response = await capture({ payload, method: 'browser-capture', track: true, key });
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain(fragment);
    expect(error).not.toContain(payload.slice(CAPTURE_GZIP_TAG.length, CAPTURE_GZIP_TAG.length + 16));
    expect(await decksOf(owner.user)).toEqual([]);
  });

  it('reports an envelope that inflates to something other than a deck as unusable', async () => {
    const response = await capture({
      payload: gzipPayload('{"nope":1}'),
      method: 'browser-capture',
      track: true,
      key,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('not a usable Moxfield deck');
  });

  it('authenticates before inflating anything', async () => {
    const bomb = gzipPayload(' '.repeat(MAX_DECODED_CAPTURE_BYTES + 1));
    const response = await capture({ payload: bomb, method: 'manual-paste', track: true });
    expect(response.status).toBe(401);
  });
});

describe('POST /api/capture continuing an existing deck’s history', () => {
  /** The Blue Farm deck deleted on Moxfield and made again: same cards, a new public id. */
  const recreated = () =>
    JSON.stringify(buildCaptureEnvelope(blueFarmSpec({ publicId: 'BlueFarmRecreated00002' })));

  async function trackedDeck(): Promise<string> {
    const response = await capture({ payload: envelope(), method: 'browser-capture', track: true, key });
    const outcome = (await response.json()) as { deckId: string };
    return outcome.deckId;
  }

  it('offers the user’s decks with an untracked deck, then continues the chosen one', async () => {
    const deckId = await trackedDeck();
    const untracked = await capture({ payload: recreated(), method: 'browser-capture', track: false, key });
    expect(await untracked.json()).toMatchObject({
      status: 'untracked',
      externalId: 'BlueFarmRecreated00002',
      decks: [{ id: deckId, name: 'Blue Farm', versionCount: 0 }],
    });

    const continued = await capture({
      payload: await encodeCapturePayload(recreated()),
      method: 'browser-capture',
      track: false,
      relinkDeckId: deckId,
      key,
    });
    expect(continued.status).toBe(200);
    expect(await continued.json()).toEqual({ status: 'ingested', deckId, changedSinceLastObservation: true });
    const overview = await harness().servicesForWorkspace(owner.user.workspaceId).getOverview(deckId);
    expect(overview).toMatchObject({
      externalId: 'BlueFarmRecreated00002',
      relinks: [{ externalId: 'BlueFarmRecreated00002' }],
    });
    expect(await decksOf(owner.user)).toEqual(['Blue Farm']);
  });

  it('answers 404 for a deck that is not the user’s, and 400 for a deck tracked twice', async () => {
    const other = await signUp(harness().auth, 'Pekka');
    const theirs = await harness()
      .servicesForWorkspace(other.user.workspaceId)
      .ingestCapture({ data: buildCaptureEnvelope(blueFarmSpec()), method: 'browser-capture', track: true });
    if (theirs.status !== 'ingested') throw new Error('not ingested');
    const notFound = await capture({
      payload: recreated(),
      method: 'browser-capture',
      track: false,
      relinkDeckId: theirs.deckId,
      key,
    });
    expect(notFound.status).toBe(404);

    const deckId = await trackedDeck();
    await capture({ payload: recreated(), method: 'browser-capture', track: true, key });
    const taken = await capture({
      payload: recreated(),
      method: 'browser-capture',
      track: false,
      relinkDeckId: deckId,
      key,
    });
    expect(taken.status).toBe(400);
    expect(((await taken.json()) as { error: string }).error).toContain(
      'already tracks that Moxfield deck. To continue this deck’s history with it instead',
    );
  });

  it('rejects a malformed deck id by shape', async () => {
    const response = await capture({
      payload: recreated(),
      method: 'browser-capture',
      track: false,
      relinkDeckId: 'x'.repeat(129),
      key,
    });
    expect(response.status).toBe(400);
    expect(await decksOf(owner.user)).toEqual([]);
  });
});
