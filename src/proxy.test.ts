/**
 * `src/proxy.ts`: the DNS-rebinding host guard runs before anything else (including
 * Basic auth) on every route that holds user data, and Basic auth still applies to
 * requests addressed to an allowed host.
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

  it('checks the host before asking for Basic auth credentials', () => {
    vi.stubEnv('BASIC_AUTH_USER', 'me');
    vi.stubEnv('BASIC_AUTH_PASSWORD', 'secret');
    expect(proxy(request('/', { host: REBOUND })).status).toBe(421);

    const unauthenticated = proxy(request('/', { host: 'localhost:3000' }));
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toContain('Basic');

    const authorization = `Basic ${Buffer.from('me:secret').toString('base64')}`;
    expect(passedThrough(proxy(request('/', { host: 'localhost:3000', authorization })))).toBe(true);
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
