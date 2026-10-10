/**
 * `POST /api/capture/form` (the same-tab bookmarklet's target) against the real auth and
 * deck services on an in-memory database: the bookmarklet key authenticates the
 * cross-site post and picks the workspace, the answer hands the browser a pending,
 * short-lived hand-off for `/api/auth/handoff` (which signs nobody in by itself), the
 * `Origin` header only rules out explicit third-party origins, and keys never reach logs
 * or pages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CAPTURE_FORM_FIELD,
  CAPTURE_FORM_TOKEN_FIELD,
  MAX_CAPTURE_BYTES,
} from '@/integrations/moxfield/capture-protocol';
import type * as AccessModule from '@/server/access';
import type * as AuthModule from '@/server/auth';
import { HANDOFF_LIFETIME_MS } from '@/server/auth/service';
import type { SessionUser, SignIn } from '@/server/auth/types';
import type * as ConfigModule from '@/server/config';
import type { AppConfig } from '@/server/config';
import { keyOfBookmarklet, signUp } from '@tests/support/auth';
import { buildCaptureEnvelope } from '@tests/support/moxfield-deck-builder';
import { appRequest, setCookies } from '@tests/support/routes';
import { blueFarmSpec, createServiceHarness, defined, type ServiceHarness } from '@tests/support/services';

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

const { POST } = await import('@/app/api/capture/form/route');

const MOXFIELD = 'https://moxfield.com';

let owner: SignIn;
let key: string;

beforeEach(async () => {
  state.harness = createServiceHarness();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(state.harness.clock.now());
  state.logs.length = 0;
  owner = await signUp(harness().auth, 'Mikko');
  key = keyOfBookmarklet(
    (await harness().auth.createBookmarkletKey(owner.user, 'Phone', 'http://localhost:3000')).bookmarklets
      .sameTab,
  );
});

afterEach(() => {
  vi.useRealTimers();
  state.harness = undefined;
});

interface PostOptions {
  /** `Origin` header, or `null` to send none. Default `'null'` (the opaque origin). */
  origin?: string | null;
  /** Form fields; default: the user's key and a Blue Farm envelope. */
  fields?: Record<string, string>;
}

function post({ origin = 'null', fields }: PostOptions = {}): Promise<Response> {
  const body = new URLSearchParams(
    fields ?? {
      [CAPTURE_FORM_TOKEN_FIELD]: key,
      [CAPTURE_FORM_FIELD]: JSON.stringify(buildCaptureEnvelope(blueFarmSpec())),
    },
  );
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    'sec-fetch-site': 'cross-site',
    'user-agent': 'Safari on iPhone',
  };
  if (origin !== null) headers.origin = origin;
  return POST(appRequest('/api/capture/form', { method: 'POST', headers, body }));
}

async function ownersDecks(): Promise<{ id: string; name: string }[]> {
  return (await harness().servicesForWorkspace(owner.user.workspaceId).listDecks()).map(({ id, name }) => ({
    id,
    name,
  }));
}

/** Where a hand-off redirect finally leads. */
function handoffTarget(response: Response): string | null {
  const location = response.headers.get('location') ?? '';
  const url = new URL(location, 'http://localhost:3000');
  return url.pathname === '/api/auth/handoff' ? url.searchParams.get('next') : null;
}

describe('POST /api/capture/form', () => {
  it.each([
    ['the opaque origin (https Moxfield → http git-moxfield)', 'null'],
    ['no Origin header', null],
    ['the configured Moxfield origin', MOXFIELD],
  ])('captures into the key owner’s workspace with %s and hands the sign-in off', async (_case, origin) => {
    const response = await post({ origin });
    expect(response.status).toBe(303);
    const [deck] = await ownersDecks();
    expect(deck?.name).toBe('Blue Farm');
    expect(handoffTarget(response)).toBe(`/decks/${deck?.id}?captured=1`);

    const cookies = setCookies(response);
    // No session cookie here: this cross-site post cannot see the browser's own one.
    expect([...cookies.keys()]).toEqual(['__Host-gm_handoff']);
    const handoff = defined(cookies.get('__Host-gm_handoff'));
    expect(handoff.value).toMatch(/^gms_[A-Za-z0-9_-]{43}$/);
    expect(handoff.attributes).toMatchObject({ path: '/', httponly: true, samesite: 'Lax', secure: true });
    expect(Number(handoff.attributes['max-age'])).toBe(HANDOFF_LIFETIME_MS / 1000);
    // A pending hand-off for the key's owner, which signs nobody in until confirmed.
    expect(await harness().auth.resolveSession(handoff.value)).toBeNull();
    expect(await harness().auth.describeHandoff(handoff.value, null)).toMatchObject({
      displayName: 'Mikko',
      keyLabel: 'Phone',
    });
  });

  it('accepts anyone’s valid key from any page, but only ever into that key owner’s own workspace', async () => {
    // What a forged post can do: Mallory posts her own key from her page with `Origin: null`.
    const mallory = await signUp(harness().auth, 'Mallory');
    const malloryKey = keyOfBookmarklet(
      (await harness().auth.createBookmarkletKey(mallory.user, 'Hers', 'http://localhost:3000')).bookmarklets
        .sameTab,
    );
    const response = await post({
      fields: { [CAPTURE_FORM_TOKEN_FIELD]: malloryKey, [CAPTURE_FORM_FIELD]: '' },
    });
    expect(response.status).toBe(303);
    expect(handoffTarget(response)).toBe('/capture?mode=paste&error=invalid');
    expect([...setCookies(response).keys()]).toEqual(['__Host-gm_handoff']);
    expect(await ownersDecks()).toEqual([]);
    expect((await harness().auth.listSessions(mallory.user)).map((entry) => entry.id)).toEqual([
      mallory.session.id,
    ]);
  });

  it('ingests a large deck whose form-encoded body is well over 10 MB', async () => {
    // A huge Considering board: the envelope stays under MAX_CAPTURE_BYTES, but form
    // encoding (every quote, colon, comma and brace becomes %XX) grows it by about 1.5x.
    const considering = Array.from({ length: 11_000 }, (_, i) => `Considered Card ${i}`);
    const payload = JSON.stringify(buildCaptureEnvelope(blueFarmSpec({ considering })));
    const fields = { [CAPTURE_FORM_TOKEN_FIELD]: key, [CAPTURE_FORM_FIELD]: payload };
    expect(payload.length).toBeGreaterThan(7_000_000);
    expect(payload.length).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
    expect(new URLSearchParams(fields).toString().length).toBeGreaterThan(11 * 1024 * 1024);

    const response = await post({ fields });
    expect(response.status).toBe(303);
    const [deck] = await ownersDecks();
    expect(handoffTarget(response)).toBe(`/decks/${deck?.id}?captured=1`);
  }, 60_000);

  it('rejects an explicit third-party origin before reading the body', async () => {
    const response = await post({ origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('<h1>Deck not accepted</h1>');
    expect(await ownersDecks()).toEqual([]);
    expect(state.logs).toEqual([
      expect.objectContaining({
        level: 'warn',
        message: 'Rejected same-tab capture from an unexpected origin',
        context: expect.objectContaining({ origin: 'https://evil.example' }) as unknown,
      }),
    ]);
    expect(await harness().auth.listKeys(owner.user)).toEqual([
      expect.objectContaining({ lastUsedAt: null }),
    ]);
  });

  it.each([
    ['missing', undefined, 'missing'],
    ['empty', '', 'malformed'],
    ['the capture token of a bookmarklet made before accounts', 'f'.repeat(64), 'malformed'],
    ['well-formed but unknown', `gmk_${'Q'.repeat(43)}`, 'unknown'],
  ])('rejects a capture whose key is %s, without logging keys', async (_case, sent, logged) => {
    const fields: Record<string, string> = {
      [CAPTURE_FORM_FIELD]: JSON.stringify(buildCaptureEnvelope(blueFarmSpec())),
    };
    if (sent !== undefined) fields[CAPTURE_FORM_TOKEN_FIELD] = sent;

    const response = await post({ fields });
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(setCookies(response).size).toBe(0);
    const html = await response.text();
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<h1>Reinstall the bookmarklet</h1>');
    expect(html).toContain('<a href="/setup">Open Connect Moxfield</a>');
    expect(html).not.toContain(key);
    expect(await ownersDecks()).toEqual([]);

    expect(state.logs).toEqual([
      {
        level: 'warn',
        message: 'Rejected same-tab capture without a valid bookmarklet key',
        context: { origin: 'null', secFetchSite: 'cross-site', key: logged },
      },
    ]);
    expect(JSON.stringify(state.logs)).not.toContain(key);
  });

  it('rejects revoked keys and the keys of disabled users', async () => {
    const [created] = await harness().auth.listKeys(owner.user);
    await harness().auth.revokeKey(owner.user, defined(created).id);
    expect((await post()).status).toBe(403);

    const anna = await signUp(harness().auth, 'Anna');
    key = keyOfBookmarklet(
      (await harness().auth.createBookmarkletKey(anna.user, 'Phone', 'http://localhost:3000')).bookmarklets
        .sameTab,
    );
    harness().repos.users.setDisabled(anna.user.id, true);
    expect((await post()).status).toBe(403);
  });

  it('checks the key before looking at the payload', async () => {
    const response = await post({ fields: { [CAPTURE_FORM_FIELD]: 'not json' } });
    expect(response.status).toBe(403);
  });

  it('sends unusable payloads with a valid key to the paste page, through the sign-in hand-off', async () => {
    const response = await post({
      fields: { [CAPTURE_FORM_TOKEN_FIELD]: key, [CAPTURE_FORM_FIELD]: 'not json' },
    });
    expect(response.status).toBe(303);
    expect(handoffTarget(response)).toBe('/capture?mode=paste&error=invalid');
    expect(setCookies(response).has('__Host-gm_handoff')).toBe(true);
    expect(await ownersDecks()).toEqual([]);
  });
});
