/**
 * The account route handlers: `GET` and `POST /api/auth/handoff` (finishing a same-tab
 * bookmarklet sign-in, asking first unless the browser is signed in as the key's owner)
 * and the end-to-end suite's test-only `POST /api/e2e/session` and
 * `GET /api/e2e/setup-code`, against the real auth service on an in-memory database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as AuthModule from '@/server/auth';
import { HANDOFF_LIFETIME_MS } from '@/server/auth/service';
import type { SignIn } from '@/server/auth/types';
import type * as ConfigModule from '@/server/config';
import { parseConfig, type AppConfig } from '@/server/config';
import { keyOfBookmarklet, signUp } from '@tests/support/auth';
import { appRequest, setCookies } from '@tests/support/routes';
import { createServiceHarness, defined, type ServiceHarness } from '@tests/support/services';

const state = vi.hoisted(() => ({
  harness: undefined as ServiceHarness | undefined,
  config: undefined as AppConfig | undefined,
}));

function harness(): ServiceHarness {
  if (state.harness === undefined) throw new Error('No harness for this test');
  return state.harness;
}

vi.mock('@/server/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  getAuthService: () => harness().auth,
}));
vi.mock('@/server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigModule>()),
  getConfig: (): AppConfig => state.config ?? harness().config,
}));

const { GET: handoffRoute, POST: handoffConfirmRoute } = await import('@/app/api/auth/handoff/route');
const { POST: e2eSession } = await import('@/app/api/e2e/session/route');
const { GET: e2eSetupCode } = await import('@/app/api/e2e/setup-code/route');

beforeEach(() => {
  state.harness = createServiceHarness();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(state.harness.clock.now());
});

afterEach(() => {
  vi.useRealTimers();
  state.harness = undefined;
  state.config = undefined;
});

async function keyOwner(name = 'Mikko'): Promise<{ owner: SignIn; key: string }> {
  const owner = await signUp(harness().auth, name);
  const created = await harness().auth.createBookmarkletKey(owner.user, 'Phone', 'http://localhost:3000');
  return { owner, key: keyOfBookmarklet(created.bookmarklets.sameTab) };
}

const SESSION = '__Host-gm_session';
const HANDOFF = '__Host-gm_handoff';

function handoff(next: string, cookies: Record<string, string>): Promise<Response> {
  return handoffRoute(appRequest(`/api/auth/handoff?next=${encodeURIComponent(next)}`, { cookies }));
}

/** The confirmation page's form post. `site`: what the browser says about where it came from. */
function confirm(
  fields: Record<string, string>,
  cookies: Record<string, string>,
  site: { origin?: string; secFetchSite?: string } = {
    origin: 'http://localhost:3000',
    secFetchSite: 'same-origin',
  },
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (site.origin !== undefined) headers.origin = site.origin;
  if (site.secFetchSite !== undefined) headers['sec-fetch-site'] = site.secFetchSite;
  return handoffConfirmRoute(
    appRequest('/api/auth/handoff', { method: 'POST', headers, cookies, body: new URLSearchParams(fields) }),
  );
}

describe('GET /api/auth/handoff', () => {
  it('asks a signed-out browser first: nothing is signed in, the hand-off waits for the confirmation page', async () => {
    const { key } = await keyOwner();
    const started = defined(await harness().auth.startKeyHandoff(key, 'Safari'));

    const response = await handoff('/decks/abc?captured=1', { [HANDOFF]: started.handoff.token });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/signin/bookmarklet?next=%2Fdecks%2Fabc%3Fcaptured%3D1');
    // No cookie changes: the hand-off cookie stays for the confirmation, no session is set.
    expect(setCookies(response).size).toBe(0);
    expect(await harness().auth.resolveSession(started.handoff.token)).toBeNull();
  });

  it('keeps the browser’s own session of the same user without asking, and ends the hand-off', async () => {
    const { owner, key } = await keyOwner();
    const started = defined(await harness().auth.startKeyHandoff(key, 'Safari'));
    const response = await handoff('/decks/abc', {
      [HANDOFF]: started.handoff.token,
      [SESSION]: owner.session.token,
    });
    expect(response.headers.get('location')).toBe('/decks/abc');
    const cookies = setCookies(response);
    expect(cookies.get(HANDOFF)).toMatchObject({ value: '', attributes: { 'max-age': '0', path: '/' } });
    const session = defined(cookies.get(SESSION));
    expect(session.value).toBe(owner.session.token);
    expect(session.attributes).toMatchObject({ path: '/', httponly: true, samesite: 'Lax', secure: true });
    expect(cookies.get('__Host-gm_session_fresh')?.value).toBe('1');
    expect(await harness().auth.confirmHandoff(started.handoff.token, null)).toBeNull();
    expect(await harness().auth.listSessions(owner.user)).toHaveLength(1);
  });

  it('never switches a browser signed in as another user: it asks, leaving that session alone (AUTH-1)', async () => {
    const { owner, key } = await keyOwner('Attacker');
    const victim = await signUp(harness().auth, 'Victim');
    const started = defined(await harness().auth.startKeyHandoff(key, 'Safari'));
    const response = await handoff('/capture?mode=paste&error=invalid', {
      [HANDOFF]: started.handoff.token,
      [SESSION]: victim.session.token,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      '/signin/bookmarklet?next=%2Fcapture%3Fmode%3Dpaste%26error%3Dinvalid',
    );
    expect(setCookies(response).size).toBe(0);
    expect((await harness().auth.resolveSession(victim.session.token))?.id).toBe(victim.user.id);
    expect(harness().repos.sessions.listActiveForUser(owner.user.id, harness().clock.iso())).toHaveLength(1);
    expect(await harness().auth.resolveSession(started.handoff.token)).toBeNull();
  });

  it.each([
    ['without a hand-off cookie', {}],
    ['with an unknown hand-off token', { [HANDOFF]: `gms_${'Q'.repeat(43)}` }],
    ['with a cookie from another context (unprefixed)', { gm_handoff: `gms_${'Q'.repeat(43)}` }],
  ])('only redirects %s', async (_case, cookies) => {
    const response = await handoff('/decks/abc', cookies);
    expect(response.headers.get('location')).toBe('/decks/abc');
    expect(setCookies(response).has(SESSION)).toBe(false);
  });

  it('ignores a planted ordinary session token posing as a hand-off (cookie tossing)', async () => {
    const attacker = await signUp(harness().auth, 'Attacker');
    const victim = await signUp(harness().auth, 'Victim');
    const response = await handoff('/', {
      [HANDOFF]: attacker.session.token,
      [SESSION]: victim.session.token,
    });
    expect(response.headers.get('location')).toBe('/');
    expect(setCookies(response).has(SESSION)).toBe(false);
    expect(await harness().auth.resolveSession(victim.session.token)).not.toBeNull();
  });

  it.each([
    'https://evil.example/',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    '/.//evil.example/phish',
    '/..//evil.example',
    '/a/..//evil.example',
    '/%2e%2e//evil.example',
  ])('never redirects off-site (next=%j)', async (next) => {
    const response = await handoff(next, {});
    expect(response.headers.get('location')).toBe('/');
  });
});

describe('POST /api/auth/handoff (the confirmation page)', () => {
  it('signs a signed-out browser in when confirmed on the app’s own page', async () => {
    const { owner, key } = await keyOwner();
    const started = defined(await harness().auth.startKeyHandoff(key, 'Safari'));
    const response = await confirm(
      { intent: 'confirm', next: '/decks/abc?captured=1' },
      { [HANDOFF]: started.handoff.token },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/decks/abc?captured=1');
    const cookies = setCookies(response);
    expect(cookies.get(HANDOFF)).toMatchObject({ value: '', attributes: { 'max-age': '0' } });
    const session = defined(cookies.get(SESSION));
    expect(session.value).toBe(started.handoff.token);
    expect(Number(session.attributes['max-age'])).toBe(400 * 86_400);
    expect((await harness().auth.resolveSession(session.value))?.id).toBe(owner.user.id);
  });

  it('switches a browser signed in as someone else only now, ending that session', async () => {
    const { owner, key } = await keyOwner();
    const anna = await signUp(harness().auth, 'Anna');
    const started = defined(await harness().auth.startKeyHandoff(key, 'Safari'));
    const response = await confirm(
      { intent: 'confirm', next: '/' },
      { [HANDOFF]: started.handoff.token, [SESSION]: anna.session.token },
    );
    const token = setCookies(response).get(SESSION)?.value;
    expect((await harness().auth.resolveSession(token))?.id).toBe(owner.user.id);
    expect(await harness().auth.resolveSession(anna.session.token)).toBeNull();
  });

  it.each([
    ['no Origin', {}],
    ['the opaque Origin a no-referrer page sends with its own form post', { origin: 'null' }],
  ])('relies on the browser’s Sec-Fetch-Site: same-origin when it sends %s', async (_case, site) => {
    const { key } = await keyOwner();
    const started = defined(await harness().auth.startKeyHandoff(key, 'Safari'));
    const response = await confirm(
      { intent: 'confirm', next: '/' },
      { [HANDOFF]: started.handoff.token },
      { ...site, secFetchSite: 'same-origin' },
    );
    expect(setCookies(response).has(SESSION)).toBe(true);
  });

  it.each([
    ['another site’s origin', { origin: 'https://evil.example', secFetchSite: 'cross-site' }],
    ['the opaque origin', { origin: 'null', secFetchSite: 'cross-site' }],
    ['the opaque origin without Sec-Fetch-Site', { origin: 'null' }],
    ['the opaque origin from the same site', { origin: 'null', secFetchSite: 'same-site' }],
    ['no Origin and a cross-site fetch', { secFetchSite: 'cross-site' }],
    ['no Origin and no Sec-Fetch-Site', {}],
    ['the same site on another port', { origin: 'http://localhost:4000', secFetchSite: 'same-site' }],
  ])('refuses a confirmation from %s with 403, changing nothing', async (_case, site) => {
    const { key } = await keyOwner();
    const anna = await signUp(harness().auth, 'Anna');
    const started = defined(await harness().auth.startKeyHandoff(key, 'Safari'));
    const response = await confirm(
      { intent: 'confirm', next: '/' },
      { [HANDOFF]: started.handoff.token, [SESSION]: anna.session.token },
      site,
    );
    expect(response.status).toBe(403);
    expect(setCookies(response).size).toBe(0);
    expect(await harness().auth.resolveSession(anna.session.token)).not.toBeNull();
    expect(await harness().auth.resolveSession(started.handoff.token)).toBeNull();
    expect(await harness().auth.describeHandoff(started.handoff.token, null)).not.toBeNull();
  });

  it('sends an expired hand-off back to the confirmation page, which says so', async () => {
    const { key } = await keyOwner();
    const started = defined(await harness().auth.startKeyHandoff(key, 'Safari'));
    harness().clock.advance(HANDOFF_LIFETIME_MS / 1000);
    vi.setSystemTime(harness().clock.now());
    const response = await confirm(
      { intent: 'confirm', next: '/decks/abc' },
      { [HANDOFF]: started.handoff.token },
    );
    expect(response.headers.get('location')).toBe('/signin/bookmarklet?next=%2Fdecks%2Fabc');
    expect(setCookies(response).has(SESSION)).toBe(false);
    expect(setCookies(response).get(HANDOFF)?.value).toBe('');
  });

  it('cancels: the hand-off ends, the browser’s session stays', async () => {
    const { key } = await keyOwner();
    const anna = await signUp(harness().auth, 'Anna');
    const started = defined(await harness().auth.startKeyHandoff(key, 'Safari'));
    const response = await confirm(
      { intent: 'cancel', next: '/decks/abc' },
      { [HANDOFF]: started.handoff.token, [SESSION]: anna.session.token },
    );
    expect(response.headers.get('location')).toBe('/');
    expect(setCookies(response).has(SESSION)).toBe(false);
    expect(setCookies(response).get(HANDOFF)?.value).toBe('');
    expect(await harness().auth.resolveSession(anna.session.token)).not.toBeNull();
    expect(await harness().auth.confirmHandoff(started.handoff.token, null)).toBeNull();
  });

  it('never redirects off-site, and refuses unknown intents and other content types', async () => {
    const { key } = await keyOwner();
    const started = defined(await harness().auth.startKeyHandoff(key, 'Safari'));
    expect((await confirm({ intent: 'nope' }, { [HANDOFF]: started.handoff.token })).status).toBe(400);
    const json = await handoffConfirmRoute(
      appRequest('/api/auth/handoff', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
        body: JSON.stringify({ intent: 'confirm' }),
      }),
    );
    expect(json.status).toBe(415);
    const response = await confirm(
      { intent: 'confirm', next: '/.//evil.example' },
      { [HANDOFF]: started.handoff.token },
    );
    expect(response.headers.get('location')).toBe('/');
  });

  it('ends no session on the strength of a session cookie the request carries twice', async () => {
    const { key } = await keyOwner();
    const anna = await signUp(harness().auth, 'Anna');
    const started = defined(await harness().auth.startKeyHandoff(key, 'Safari'));
    const request = appRequest('/api/auth/handoff', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:3000',
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `${HANDOFF}=${started.handoff.token}; ${SESSION}=${anna.session.token}; ${SESSION}=gms_${'P'.repeat(43)}`,
      },
      body: new URLSearchParams({ intent: 'confirm', next: '/' }),
    });
    const response = await handoffConfirmRoute(request);
    expect(setCookies(response).get(SESSION)?.value).toBe(started.handoff.token);
    expect(await harness().auth.resolveSession(anna.session.token)).not.toBeNull();
  });
});

describe('test-only e2e endpoints', () => {
  function enableE2e(env: Record<string, string> = {}): void {
    state.config = parseConfig({ GIT_MOXFIELD_E2E: 'true', PUBLIC_APP_URL: 'http://localhost:3100', ...env });
  }

  function session(body: unknown): Promise<Response> {
    return e2eSession(
      appRequest('/api/e2e/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  it('refuse forms, simple requests and cross-origin browsers (defence in depth)', async () => {
    enableE2e();
    const textPlain = await e2eSession(
      appRequest('/api/e2e/session', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ role: 'admin' }),
      }),
    );
    expect(textPlain.status).toBe(415);
    const crossOrigin: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
    ];
    for (const headers of crossOrigin) {
      const response = await e2eSession(
        appRequest('/api/e2e/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ role: 'admin' }),
        }),
      );
      expect(response.status).toBe(403);
    }
    expect(harness().repos.users.count()).toBe(0);
  });

  it('do not exist unless GIT_MOXFIELD_E2E is set', async () => {
    state.config = parseConfig({});
    expect((await session({})).status).toBe(404);
    expect((await e2eSetupCode()).status).toBe(404);
    expect(harness().repos.users.count()).toBe(0);
  });

  it('sign a new user in, with an optional bookmarklet', async () => {
    enableE2e();
    const response = await session({ displayName: 'Tester', role: 'admin', bookmarkletLabel: 'E2E' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: { id: string; displayName: string; role: string };
      sessionCookie: { name: string; value: string; secure: boolean };
      bookmarklets: { popup: string; sameTab: string };
    };
    expect(body.user).toMatchObject({ displayName: 'Tester', role: 'admin' });
    expect(body.sessionCookie).toMatchObject({ name: '__Host-gm_session', secure: true });
    expect(setCookies(response).get('__Host-gm_session')?.value).toBe(body.sessionCookie.value);
    expect((await harness().auth.resolveSession(body.sessionCookie.value))?.id).toBe(body.user.id);

    const key = keyOfBookmarklet(body.bookmarklets.sameTab);
    expect(decodeURIComponent(body.bookmarklets.popup)).toContain('"app":"http://localhost:3100"');
    expect((await harness().auth.signInWithKey(key, 'Chromium'))?.user.id).toBe(body.user.id);
  });

  it('make a member with a generated name by default', async () => {
    enableE2e();
    const body = (await (await session({})).json()) as { user: { displayName: string; role: string } };
    expect(body.user.role).toBe('member');
    expect(body.user.displayName).toMatch(/^Tester [0-9a-f]{6}$/);
    expect((await session({ role: 'owner' })).status).toBe(400);
  });

  it('read the setup code while the installation is unclaimed', async () => {
    enableE2e();
    const code = ((await (await e2eSetupCode()).json()) as { setupCode: string | null }).setupCode;
    expect(code).toBe(await harness().auth.setupCode());
    expect(code).not.toBeNull();
    await session({});
    expect(await (await e2eSetupCode()).json()).toEqual({ setupCode: null });
  });
});
