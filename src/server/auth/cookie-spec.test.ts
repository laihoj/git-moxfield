import { describe, expect, it } from 'vitest';

import {
  cookieNames,
  expiredFreshMarkerCookie,
  expiredHandoffCookie,
  expiredSessionCookie,
  freshMarkerCookie,
  handoffCookie,
  isCookieAmbiguous,
  establishedSessionCookies,
  isSecureCookieContext,
  readCookie,
  refreshedSessionCookie,
  serializeCookie,
  SESSION_MAX_AGE_S,
  sessionCookie,
} from './cookie-spec';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const TOKEN = `gms_${'A'.repeat(43)}`;
const IN_400_DAYS = new Date(NOW.getTime() + 400 * 86_400_000).toISOString();

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe('isSecureCookieContext', () => {
  it.each([
    ['an https request', { host: 'decks.example.com', 'x-forwarded-proto': 'https' }, undefined],
    ['an https request behind several proxies', { host: 'x', 'x-forwarded-proto': 'https, http' }, undefined],
    [
      'an https PUBLIC_APP_URL',
      { host: 'decks.example.com', 'x-forwarded-proto': 'http' },
      'https://decks.example.com',
    ],
    ['http://localhost', { host: 'localhost:3000', 'x-forwarded-proto': 'http' }, undefined],
    ['http://127.0.0.1', { host: '127.0.0.1:3000', 'x-forwarded-proto': 'http' }, undefined],
    ['http://[::1]', { host: '[::1]:3000', 'x-forwarded-proto': 'http' }, undefined],
    ['http://app.localhost', { host: 'app.localhost:3000', 'x-forwarded-proto': 'http' }, undefined],
    ['a forwarded localhost host', { host: 'proxy', 'x-forwarded-host': 'localhost:3100' }, undefined],
    [
      'an https PUBLIC_APP_URL in capitals',
      { host: 'decks.example.com', 'x-forwarded-proto': 'http' },
      'HTTPS://decks.example.com',
    ],
  ])('uses Secure for %s', (_case, values, publicAppUrl) => {
    expect(isSecureCookieContext(headers(values), publicAppUrl)).toBe(true);
  });

  it.each([
    ['plain http to a LAN address', { host: '192.168.1.20:3000', 'x-forwarded-proto': 'http' }, undefined],
    [
      'plain http to a host name',
      { host: 'mybox.local:3000', 'x-forwarded-proto': 'http' },
      'http://mybox.local:3000',
    ],
    ['a look-alike of localhost', { host: 'localhost.evil.example', 'x-forwarded-proto': 'http' }, undefined],
    ['no host at all', {}, undefined],
  ])('omits Secure for %s, where browsers would drop the cookie', (_case, values, publicAppUrl) => {
    expect(isSecureCookieContext(headers(values), publicAppUrl)).toBe(false);
  });
});

describe('cookie names', () => {
  it('use the __Host- prefix wherever cookies are Secure, so no other host can plant them', () => {
    expect(cookieNames(true)).toEqual({
      session: '__Host-gm_session',
      handoff: '__Host-gm_handoff',
      fresh: '__Host-gm_session_fresh',
    });
    expect(cookieNames(false)).toEqual({
      session: 'gm_session',
      handoff: 'gm_handoff',
      fresh: 'gm_session_fresh',
    });
  });

  it.each([true, false])('satisfy the __Host- rules for every cookie (secure: %s)', (secure) => {
    const all = [
      sessionCookie({ token: TOKEN, expiresAt: IN_400_DAYS }, NOW, secure),
      refreshedSessionCookie(TOKEN, secure),
      expiredSessionCookie(secure),
      handoffCookie({ token: TOKEN, expiresAt: IN_400_DAYS }, NOW, secure),
      expiredHandoffCookie(secure),
      freshMarkerCookie(secure),
      expiredFreshMarkerCookie(secure),
    ];
    for (const cookie of all) {
      expect(cookie.name.startsWith('__Host-')).toBe(secure);
      const serialized = serializeCookie(cookie);
      expect(serialized).toContain('; Path=/;');
      expect(serialized).not.toMatch(/domain=/i);
      expect(serialized.endsWith('; Secure')).toBe(secure);
      expect(serialized).toContain('HttpOnly; SameSite=Lax');
    }
  });
});

describe('session cookie', () => {
  it('is HttpOnly, SameSite=Lax, site-wide and expires with the session', () => {
    const cookie = sessionCookie({ token: TOKEN, expiresAt: IN_400_DAYS }, NOW, true);
    expect(cookie).toEqual({
      name: '__Host-gm_session',
      value: TOKEN,
      path: '/',
      maxAge: 400 * 86_400,
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    });
    expect(serializeCookie(cookie)).toBe(
      `__Host-gm_session=${TOKEN}; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure`,
    );
  });

  it('has Max-Age = the remaining lifetime, never negative', () => {
    const soon = new Date(NOW.getTime() + 90_500).toISOString();
    expect(sessionCookie({ token: TOKEN, expiresAt: soon }, NOW, false).maxAge).toBe(90);
    const past = new Date(NOW.getTime() - 1000).toISOString();
    expect(sessionCookie({ token: TOKEN, expiresAt: past }, NOW, false).maxAge).toBe(0);
  });

  it('is refreshed with the full 400 days, the browsers’ cap', () => {
    expect(SESSION_MAX_AGE_S).toBe(34_560_000);
    expect(serializeCookie(refreshedSessionCookie(TOKEN, false))).toBe(
      `gm_session=${TOKEN}; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax`,
    );
  });

  it('is deleted with an empty, expired cookie of the same scope', () => {
    expect(serializeCookie(expiredSessionCookie(true))).toBe(
      '__Host-gm_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure',
    );
  });
});

describe('hand-off cookie', () => {
  it('lives as long as the pending hand-off', () => {
    const expiresAt = new Date(NOW.getTime() + 5 * 60_000).toISOString();
    expect(handoffCookie({ token: TOKEN, expiresAt }, NOW, false)).toMatchObject({
      name: 'gm_handoff',
      path: '/',
      maxAge: 300,
      httpOnly: true,
    });
    expect(serializeCookie(expiredHandoffCookie(false))).toBe(
      'gm_handoff=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    );
  });
});

describe('freshness marker', () => {
  it('holds no secret and lasts a day', () => {
    expect(serializeCookie(freshMarkerCookie(true))).toBe(
      '__Host-gm_session_fresh=1; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax; Secure',
    );
  });
});

describe('readCookie', () => {
  it('reads one cookie out of a Cookie header', () => {
    expect(readCookie(`a=1; __Host-gm_session=${TOKEN}; b=2`, '__Host-gm_session')).toBe(TOKEN);
    expect(readCookie(`gm_session=${TOKEN}`, 'gm_session')).toBe(TOKEN);
  });

  it.each([
    ['no Cookie header', null],
    ['an empty header', ''],
    ['another cookie only', 'gm_session_fresh=1'],
    ['a name that only ends like it', `x_gm_session=${TOKEN}`],
    ['a pair without a value separator', 'gm_session'],
  ])('finds nothing in %s', (_case, header) => {
    expect(readCookie(header, 'gm_session')).toBeNull();
  });

  it('treats a cookie sent twice as absent: one of them may be planted for a parent domain', () => {
    const planted = `gms_${'B'.repeat(43)}`;
    expect(readCookie(`gm_session=${TOKEN}; gm_session=${planted}`, 'gm_session')).toBeNull();
    expect(readCookie(`gm_session=${TOKEN}; gm_session=${TOKEN}`, 'gm_session')).toBeNull();
    expect(isCookieAmbiguous(`gm_session=${TOKEN}; gm_session=${planted}`, 'gm_session')).toBe(true);
    expect(isCookieAmbiguous(`gm_session=${TOKEN}; xgm_session=${planted}`, 'gm_session')).toBe(false);
    expect(isCookieAmbiguous(null, 'gm_session')).toBe(false);
  });

  it('never reads the unprefixed name for the __Host- one or the other way round', () => {
    expect(readCookie(`gm_session=${TOKEN}`, '__Host-gm_session')).toBeNull();
    expect(readCookie(`__Host-gm_session=${TOKEN}`, 'gm_session')).toBeNull();
  });
});

describe('establishedSessionCookies', () => {
  it('are the session cookie and the freshness marker, set together', () => {
    const session = { token: TOKEN, expiresAt: IN_400_DAYS };
    for (const secure of [true, false]) {
      expect(establishedSessionCookies(session, NOW, secure)).toEqual([
        sessionCookie(session, NOW, secure),
        freshMarkerCookie(secure),
      ]);
    }
  });
});
