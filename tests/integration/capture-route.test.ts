/**
 * `POST /api/capture` (the popup bookmarklet's capture page and the paste form) against
 * the real auth and deck services on an in-memory database: a bookmarklet key signs the
 * browser in and decides the workspace; without one the session cookie does; neither is
 * a 401. Keys and tokens never reach the logs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as AccessModule from '@/server/access';
import type * as AuthModule from '@/server/auth';
import type { SessionUser, SignIn } from '@/server/auth/types';
import type * as ConfigModule from '@/server/config';
import type { AppConfig } from '@/server/config';
import { keyOfBookmarklet, signUp } from '@tests/support/auth';
import { buildCaptureEnvelope } from '@tests/support/moxfield-deck-builder';
import { appRequest, setCookies } from '@tests/support/routes';
import { blueFarmSpec, createServiceHarness, type ServiceHarness } from '@tests/support/services';

const state = vi.hoisted(() => ({
  harness: undefined as ServiceHarness | undefined,
  logs: [] as { level: string; message: string; context: Record<string, unknown> | undefined }[],
}));

function harness(): ServiceHarness {
  if (state.harness === undefined) throw new Error('No harness for this test');
  return state.harness;
}

vi.mock('@/server/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  getAuthService: () => harness().auth,
}));
vi.mock('@/server/access', async (importOriginal) => ({
  ...(await importOriginal<typeof AccessModule>()),
  servicesFor: (user: SessionUser) => harness().servicesForWorkspace(user.workspaceId),
}));
vi.mock('@/server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigModule>()),
  getConfig: (): AppConfig => harness().config,
}));
vi.mock('@/server/logger', () => ({
  createLogger: () => {
    const log =
      (level: string) =>
      (message: string, context?: Record<string, unknown>): void => {
        state.logs.push({ level, message, context });
      };
    return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
  },
}));

const { POST } = await import('@/app/api/capture/route');

const ORIGIN = 'http://localhost:3000';

let owner: SignIn;
let key: string;

beforeEach(async () => {
  state.harness = createServiceHarness();
  // Cookie lifetimes are computed with the system clock; align it with the services' clock.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(state.harness.clock.now());
  state.logs.length = 0;
  owner = await signUp(harness().auth, 'Mikko');
  key = keyOfBookmarklet(
    (await harness().auth.createBookmarkletKey(owner.user, 'Laptop', ORIGIN)).bookmarklets.popup,
  );
});

afterEach(() => {
  vi.useRealTimers();
  state.harness = undefined;
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
