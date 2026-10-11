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
      'TURSO_DATABASE_URL: expected a libsql:, https:, http:, wss:, ws: or file: URL',
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
