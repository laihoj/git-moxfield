import { describe, expect, it } from 'vitest';

import { serializeCookie } from './cookie-spec';
import { sessionRefreshCookies } from './session-refresh';

const TOKEN = `gms_${'A'.repeat(43)}`;

function refresh(init: { method?: string; pathname?: string; cookie?: string }, secure = true): string[] {
  const headers = new Headers(init.cookie === undefined ? {} : { cookie: init.cookie });
  return sessionRefreshCookies(
    { method: init.method ?? 'GET', pathname: init.pathname ?? '/decks/abc', headers },
    secure,
  ).map(serializeCookie);
}

describe('sessionRefreshCookies', () => {
  it('re-sets the session cookie with the full lifetime and marks it fresh for a day', () => {
    expect(refresh({ cookie: `__Host-gm_session=${TOKEN}` })).toEqual([
      `__Host-gm_session=${TOKEN}; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure`,
      '__Host-gm_session_fresh=1; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax; Secure',
    ]);
    expect(refresh({ method: 'HEAD', cookie: `__Host-gm_session=${TOKEN}` })).toHaveLength(2);
  });

  it('uses the plain names where cookies cannot be Secure', () => {
    expect(refresh({ cookie: `gm_session=${TOKEN}` }, false)).toEqual([
      `gm_session=${TOKEN}; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax`,
      'gm_session_fresh=1; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax',
    ]);
  });

  it.each([
    ['a POST (server actions set or delete the cookie themselves)', { method: 'POST' }],
    ['the hand-off route, which sets the cookie itself', { pathname: '/api/auth/handoff' }],
    ['a browser refreshed within the last day', { extra: '__Host-gm_session_fresh=1' }],
  ])('leaves %s alone', (_case, init: { method?: string; pathname?: string; extra?: string }) => {
    const cookie = [`__Host-gm_session=${TOKEN}`, init.extra].filter(Boolean).join('; ');
    expect(refresh({ ...init, cookie })).toEqual([]);
  });

  it.each([
    ['no cookies', undefined],
    ['no session cookie', 'other=1'],
    ['a malformed session cookie', '__Host-gm_session=gms_short'],
    ['another kind of token', `__Host-gm_session=gmk_${'A'.repeat(43)}`],
    ['a session cookie sent twice', `__Host-gm_session=${TOKEN}; __Host-gm_session=${TOKEN}`],
    ['only the unprefixed cookie in a secure context', `gm_session=${TOKEN}`],
  ])('sets nothing for %s', (_case, cookie) => {
    expect(refresh(cookie === undefined ? {} : { cookie })).toEqual([]);
  });
});
