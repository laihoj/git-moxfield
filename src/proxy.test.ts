/**
 * `src/proxy.ts`: the DNS-rebinding host guard runs on every route that holds user data,
 * and page views refresh the session cookie's lifetime (accounts are checked where data
 * is accessed).
 */
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import nextConfig from '../next.config';

import { config, proxy } from './proxy';

function request(path: string, headers: Record<string, string>, method = 'GET'): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, { method, headers });
}

/** Whether the proxy let the request through to the app. */
function passedThrough(response: Response): boolean {
  return response.headers.get('x-middleware-next') === '1';
}

const REBOUND = 'rebind.attacker.example:3000';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('proxy host guard', () => {
  it('answers 421 to a DNS-rebinding request and never reaches the capture endpoint', async () => {
    const response = proxy(
      request(
        '/api/capture',
        { host: REBOUND, origin: `http://${REBOUND}`, 'content-type': 'application/json' },
        'POST',
      ),
    );
    expect(response.status).toBe(421);
    expect(passedThrough(response)).toBe(false);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('ALLOWED_HOSTS');
  });

  it.each([
    ['a rebound Host on a page', '/setup', { host: REBOUND }],
    ['a spoofed X-Forwarded-Host', '/', { host: 'localhost:3000', 'x-forwarded-host': REBOUND }],
    ['a Host with userinfo', '/', { host: 'evil@localhost:3000' }],
    ['a look-alike name', '/', { host: 'localhost.attacker.example:3000' }],
  ])('rejects %s', (_case, path, headers) => {
    const response = proxy(request(path, headers));
    expect(response.status).toBe(421);
    expect(passedThrough(response)).toBe(false);
  });

  it.each(['localhost:3000', '127.0.0.1:3000', '[::1]:3000', '192.168.1.20:3000', 'app.localhost:3000'])(
    'passes Host %j through without configuration',
    (host) => {
      expect(passedThrough(proxy(request('/api/capture', { host }, 'POST')))).toBe(true);
    },
  );

  it('passes the PUBLIC_APP_URL host and ALLOWED_HOSTS entries through', () => {
    vi.stubEnv('PUBLIC_APP_URL', 'http://mybox.lan:3000');
    vi.stubEnv('ALLOWED_HOSTS', 'deck.example.com, nas.local');
    for (const host of ['mybox.lan:3000', 'deck.example.com', 'nas.local:3000']) {
      expect(passedThrough(proxy(request('/', { host })))).toBe(true);
    }
    expect(proxy(request('/', { host: REBOUND })).status).toBe(421);
  });

  it('no longer asks for HTTP Basic auth, whatever the environment says', () => {
    vi.stubEnv('BASIC_AUTH_USER', 'me');
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'secret');
    const response = proxy(request('/', { host: 'localhost:3000' }));
    expect(passedThrough(response)).toBe(true);
    expect(response.headers.get('www-authenticate')).toBeNull();
  });
});

describe('proxy session cookie refresh', () => {
  const TOKEN = `gms_${'A'.repeat(43)}`;

  function setCookies(response: Response): string[] {
    return response.headers.getSetCookie();
  }

  it('re-sets the session cookie of a page view with the full 400 days, at most daily', () => {
    const response = proxy(
      request('/decks/abc', { host: 'localhost:3000', cookie: `__Host-gm_session=${TOKEN}` }),
    );
    expect(passedThrough(response)).toBe(true);
    expect(setCookies(response)).toEqual([
      `__Host-gm_session=${TOKEN}; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure`,
      '__Host-gm_session_fresh=1; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax; Secure',
    ]);

    const fresh = proxy(
      request('/decks/abc', {
        host: 'localhost:3000',
        cookie: `__Host-gm_session=${TOKEN}; __Host-gm_session_fresh=1`,
      }),
    );
    expect(setCookies(fresh)).toEqual([]);
  });

  it('uses the plain cookie names over plain http to a LAN address', () => {
    const response = proxy(request('/', { host: '192.168.1.20:3000', cookie: `gm_session=${TOKEN}` }));
    expect(setCookies(response)[0]).toBe(
      `gm_session=${TOKEN}; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax`,
    );
  });

  it.each([
    ['a POST (a server action may be signing out)', '/account', 'POST'],
    ['the hand-off route', '/api/auth/handoff', 'GET'],
  ])('never refreshes on %s', (_case, path, method) => {
    const response = proxy(
      request(path, { host: 'localhost:3000', cookie: `__Host-gm_session=${TOKEN}` }, method),
    );
    expect(setCookies(response)).toEqual([]);
  });

  it('sets no cookie for a signed-out browser or a malformed session cookie', () => {
    expect(setCookies(proxy(request('/', { host: 'localhost:3000' })))).toEqual([]);
    expect(
      setCookies(proxy(request('/', { host: 'localhost:3000', cookie: '__Host-gm_session=gms_nope' }))),
    ).toEqual([]);
  });

  it('never refreshes for a rejected host', () => {
    const response = proxy(request('/', { host: REBOUND, cookie: `gm_session=${TOKEN}` }));
    expect(response.status).toBe(421);
    expect(setCookies(response)).toEqual([]);
  });
});

describe('proxy matcher', () => {
  it.each(['/', '/setup', '/capture', '/api/capture', '/api/capture/form', '/decks/abc/history'])(
    'runs on %s',
    (url) => {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig, url })).toBe(true);
    },
  );

  it.each(['/_next/static/chunks/app.js', '/manifest.webmanifest', '/icon.svg', '/icons/192'])(
    'skips the public asset %s',
    (url) => {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig, url })).toBe(false);
    },
  );
});
