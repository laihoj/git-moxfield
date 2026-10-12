import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { parseConfig } from './config';

describe('parseConfig — ALLOWED_HOSTS', () => {
  it('is optional', () => {
    expect(parseConfig({}).ALLOWED_HOSTS).toBeUndefined();
  });

  it('accepts comma-separated host names with optional ports', () => {
    expect(parseConfig({ ALLOWED_HOSTS: 'mybox.local, deck.example.com:443' }).ALLOWED_HOSTS).toBe(
      'mybox.local, deck.example.com:443',
    );
  });

  it('rejects entries that are not host names, naming them', () => {
    expect(() => parseConfig({ ALLOWED_HOSTS: 'mybox.local, http://deck.example.com' })).toThrow(
      /ALLOWED_HOSTS: expected host names such as mybox\.local, got "http:\/\/deck\.example\.com"/,
    );
  });
});

describe('parseConfig — CAPTURE_ALLOWED_ORIGINS', () => {
  it('defaults to the origin of the Moxfield site', () => {
    expect(parseConfig({}).captureAllowedOrigins).toEqual(['https://moxfield.com']);
  });

  it('takes the origins of a comma-separated list', () => {
    const config = parseConfig({
      CAPTURE_ALLOWED_ORIGINS: 'https://moxfield.com/decks, http://localhost:4010 ,',
    });
    expect(config.captureAllowedOrigins).toEqual(['https://moxfield.com', 'http://localhost:4010']);
  });

  it('refuses an entry that is not a URL, as a configuration error', () => {
    expect(() => parseConfig({ CAPTURE_ALLOWED_ORIGINS: 'https://moxfield.com, moxfield.org' })).toThrow(
      /CAPTURE_ALLOWED_ORIGINS: expected origins such as https:\/\/moxfield\.com, got "moxfield\.org"/,
    );
  });

  it.each(['moxfield.com:443', 'foo:bar'])(
    'refuses %j, a URL without an http(s) origin, instead of allowing the origin "null"',
    (entry) => {
      expect(() => parseConfig({ CAPTURE_ALLOWED_ORIGINS: `https://moxfield.com, ${entry}` })).toThrow(
        new RegExp(`Invalid git-moxfield configuration[\\s\\S]*CAPTURE_ALLOWED_ORIGINS: .*got "${entry}"`),
      );
    },
  );
});

describe('parseConfig — base URLs', () => {
  it('strips trailing slashes once, from the app URL and the Moxfield API base URL', () => {
    const config = parseConfig({
      PUBLIC_APP_URL: 'https://tools.example/git-moxfield//',
      MOXFIELD_API_BASE_URL: 'http://localhost:4010/api/',
    });
    expect(config.PUBLIC_APP_URL).toBe('https://tools.example/git-moxfield');
    expect(config.MOXFIELD_API_BASE_URL).toBe('http://localhost:4010/api');
    expect(parseConfig({}).PUBLIC_APP_URL).toBeUndefined();
    expect(parseConfig({}).MOXFIELD_API_BASE_URL).toBe('https://api2.moxfield.com');
  });

  it.each(['http://localhost:3000', 'http://192.168.1.5:3000', 'https://tools.example'])(
    'accepts %s as the app URL',
    (url) => {
      expect(parseConfig({ PUBLIC_APP_URL: url }).PUBLIC_APP_URL).toBe(url);
    },
  );

  it.each([
    ['PUBLIC_APP_URL', 'ftp://tools.example'],
    ['PUBLIC_APP_URL', 'javascript:alert(1)'],
    ['MOXFIELD_API_BASE_URL', 'file:///tmp/moxfield'],
    ['MOXFIELD_SITE_ORIGIN', 'ftp://moxfield.com'],
  ])('fails at startup for %s=%s, which is not an http(s) URL', (name, value) => {
    expect(() => parseConfig({ [name]: value })).toThrow(new RegExp(name));
  });
});

describe('parseConfig — GIT_MOXFIELD_E2E', () => {
  it.each(['development', 'test', undefined])('allows the test-only endpoints with NODE_ENV=%s', (env) => {
    expect(parseConfig({ GIT_MOXFIELD_E2E: 'true', NODE_ENV: env }).GIT_MOXFIELD_E2E).toBe(true);
  });

  it('refuses to start a production server with the test-only endpoints enabled', () => {
    expect(() => parseConfig({ GIT_MOXFIELD_E2E: 'true', NODE_ENV: 'production' })).toThrow(
      'Invalid git-moxfield configuration: GIT_MOXFIELD_E2E must not be set when NODE_ENV=production',
    );
  });

  it.each([undefined, 'false', '0'])('accepts production without the flag (GIT_MOXFIELD_E2E=%s)', (flag) => {
    expect(parseConfig({ GIT_MOXFIELD_E2E: flag, NODE_ENV: 'production' }).GIT_MOXFIELD_E2E).not.toBe(true);
  });
});

describe('parseConfig — database location', () => {
  it('defaults to the local file at DATABASE_PATH, as an absolute file: URL', () => {
    const { database } = parseConfig({ DATABASE_PATH: 'data/my decks.db' });
    expect(database.source).toBe('DATABASE_PATH');
    expect(database.url).toBe(pathToFileURL(resolve('data/my decks.db')).href);
    expect(database.url).toMatch(/^file:\/\/\/.*\/data\/my%20decks\.db$/);
    expect(database.authToken).toBeUndefined();
    expect(parseConfig({}).database.url).toBe(pathToFileURL(resolve('data/git-moxfield.db')).href);
  });

  it('uses TURSO_DATABASE_URL and TURSO_AUTH_TOKEN when set', () => {
    const { database } = parseConfig({
      TURSO_DATABASE_URL: ' libsql://decks-me.turso.io ',
      TURSO_AUTH_TOKEN: 'secret-token',
      DATABASE_PATH: 'data/ignored.db',
    });
    expect(database.source).toBe('TURSO_DATABASE_URL');
    expect(database.url).toBe('libsql://decks-me.turso.io');
    expect(database.authToken).toBe('secret-token');
  });

  it.each([
    'http://127.0.0.1:8080',
    'https://db.example.com',
    'wss://db.example.com',
    'file:data/x.db',
    ':memory:',
  ])('accepts the libSQL URL %s', (url) => {
    expect(parseConfig({ TURSO_DATABASE_URL: url }).database.url).toBe(url);
  });

  it('rejects other URLs without echoing them', () => {
    expect(() => parseConfig({ TURSO_DATABASE_URL: 'postgres://user:hunter2@db/app' })).toThrow(
      'TURSO_DATABASE_URL: expected a URL using libsql:, https:, http:, wss:, ws: (remote), file: or :memory: (local)',
    );
    expect(() => parseConfig({ TURSO_DATABASE_URL: 'postgres://user:hunter2@db/app' })).not.toThrow(
      /hunter2/,
    );
  });

  it('refuses a token without a URL instead of silently using the local file', () => {
    expect(() => parseConfig({ TURSO_AUTH_TOKEN: 'secret-token' })).toThrow(
      'Invalid git-moxfield configuration: TURSO_AUTH_TOKEN is set but TURSO_DATABASE_URL is not',
    );
  });

  it('never exposes the URL or the token when the configuration is logged or inspected', () => {
    const config = parseConfig({
      TURSO_DATABASE_URL: 'libsql://decks-me.turso.io?authToken=url-secret',
      TURSO_AUTH_TOKEN: 'token-secret',
    });
    const shown = [JSON.stringify(config), inspect(config, { depth: 5 }), Object.keys(config).join(',')].join(
      '\n',
    );
    expect(shown).not.toContain('url-secret');
    expect(shown).not.toContain('token-secret');
    expect(Object.keys(config)).not.toEqual(expect.arrayContaining(['TURSO_DATABASE_URL']));
    expect(Object.keys(config)).not.toEqual(expect.arrayContaining(['TURSO_AUTH_TOKEN']));
    expect(JSON.stringify(config.database)).toBe('{"source":"TURSO_DATABASE_URL"}');
  });
});

describe('parseConfig — MOXFIELD_SERVER_FETCH', () => {
  it('defaults to auto outside Netlify', () => {
    expect(parseConfig({}).MOXFIELD_SERVER_FETCH).toBe('auto');
    expect(parseConfig({ SITE_ID: 'site-1', NETLIFY_DEV: 'true' }).MOXFIELD_SERVER_FETCH).toBe('auto');
  });

  it.each([{ NETLIFY: 'true' }, { SITE_ID: 'site-1' }])(
    'defaults to off on Netlify (%j): cloud IPs are blocked by Moxfield',
    (env) => {
      expect(parseConfig(env).MOXFIELD_SERVER_FETCH).toBe('off');
    },
  );

  it.each(['auto', 'off'] as const)('keeps an explicit %s, on Netlify too', (mode) => {
    expect(parseConfig({ MOXFIELD_SERVER_FETCH: mode }).MOXFIELD_SERVER_FETCH).toBe(mode);
    expect(parseConfig({ MOXFIELD_SERVER_FETCH: mode, SITE_ID: 'site-1' }).MOXFIELD_SERVER_FETCH).toBe(mode);
  });

  it('rejects other values', () => {
    expect(() => parseConfig({ MOXFIELD_SERVER_FETCH: 'sometimes' })).toThrow(/MOXFIELD_SERVER_FETCH/);
  });
});

describe('parseConfig — MOXFIELD_MIN_REQUEST_INTERVAL_MS (ADR 0009)', () => {
  it('defaults to 2 s between any two requests of the installation', () => {
    expect(parseConfig({}).MOXFIELD_MIN_REQUEST_INTERVAL_MS).toBe(2_000);
  });

  it("never goes below 1.5 s against Moxfield's API (one call per second, with room for a late start)", () => {
    expect(parseConfig({ MOXFIELD_MIN_REQUEST_INTERVAL_MS: '1500' }).MOXFIELD_MIN_REQUEST_INTERVAL_MS).toBe(
      1_500,
    );
    expect(() => parseConfig({ MOXFIELD_MIN_REQUEST_INTERVAL_MS: '1499' })).toThrow(/at least 1500/);
    expect(() =>
      parseConfig({
        MOXFIELD_MIN_REQUEST_INTERVAL_MS: '0',
        MOXFIELD_API_BASE_URL: 'https://API2.moxfield.com/',
      }),
    ).toThrow(/at least 1500/);
    expect(() =>
      parseConfig({ MOXFIELD_MIN_REQUEST_INTERVAL_MS: '100', MOXFIELD_API_BASE_URL: 'https://moxfield.com' }),
    ).toThrow(/at least 1500/);
  });

  it('allows less against a stand-in for Moxfield (the mock server of the tests)', () => {
    expect(
      parseConfig({ MOXFIELD_MIN_REQUEST_INTERVAL_MS: '0', MOXFIELD_API_BASE_URL: 'http://127.0.0.1:4010' })
        .MOXFIELD_MIN_REQUEST_INTERVAL_MS,
    ).toBe(0);
    // A look-alike host is not Moxfield's.
    expect(
      parseConfig({ MOXFIELD_MIN_REQUEST_INTERVAL_MS: '0', MOXFIELD_API_BASE_URL: 'https://notmoxfield.com' })
        .MOXFIELD_MIN_REQUEST_INTERVAL_MS,
    ).toBe(0);
  });
});

describe('parseConfig — MOXFIELD_USER_AGENT', () => {
  const agent = 'ApprovedProject/1.0 (issued-secret-123)';

  it('never exposes the User-Agent when the configuration is logged, serialized or inspected', () => {
    const config = parseConfig({ MOXFIELD_USER_AGENT: agent, SITE_ID: 'site-1' });
    expect(config.moxfieldUserAgent?.value).toBe(agent);
    const shown = [
      JSON.stringify(config),
      inspect(config, { depth: 5 }),
      String(config.moxfieldUserAgent),
      JSON.stringify({ agent: config.moxfieldUserAgent }),
      Object.keys(config).join(','),
    ].join('\n');
    expect(shown).not.toContain('issued-secret-123');
    expect(Object.keys(config)).not.toContain('MOXFIELD_USER_AGENT');
  });

  it('is fine in the Netlify production deployment', () => {
    expect(
      parseConfig({ MOXFIELD_USER_AGENT: agent, SITE_ID: 'site-1' }).moxfieldUserAgentWarning,
    ).toBeNull();
    expect(
      parseConfig({ MOXFIELD_USER_AGENT: agent, NETLIFY: 'true', CONTEXT: 'production' })
        .moxfieldUserAgentWarning,
    ).toBeNull();
  });

  it.each([
    ['a local machine', {}],
    ['netlify dev', { SITE_ID: 'site-1', NETLIFY_DEV: 'true' }],
    ['a deploy preview', { NETLIFY: 'true', CONTEXT: 'deploy-preview' }],
    ['a branch deploy', { SITE_ID: 'site-1', CONTEXT: 'branch-deploy' }],
  ])('is warned about on %s: another database would keep a limit of its own', (_label, env) => {
    const warning = parseConfig({ ...env, MOXFIELD_USER_AGENT: agent }).moxfieldUserAgentWarning;
    expect(warning).toContain('outside the Netlify production deployment');
    expect(warning).not.toContain('issued-secret-123');
  });

  it('warns about nothing without a User-Agent', () => {
    expect(parseConfig({}).moxfieldUserAgentWarning).toBeNull();
  });
});
