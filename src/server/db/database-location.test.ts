import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DATABASE_PATH,
  databaseLocationFromEnv,
  databaseUrlScheme,
  isSupportedDatabaseUrl,
} from './database-location';

describe('database URLs', () => {
  it.each([
    ['libsql://db-org.turso.io', 'libsql'],
    ['HTTPS://db.example.com', 'https'],
    ['file:data/x.db', 'file'],
    ['data/x.db', undefined],
    [':memory:', undefined],
  ])('reads the scheme of %s', (url, scheme) => {
    expect(databaseUrlScheme(url)).toBe(scheme);
  });

  it.each([
    'libsql://db-org.turso.io',
    'https://db.example.com',
    'http://127.0.0.1:8080',
    'wss://db.example.com',
    'ws://127.0.0.1:8080',
    'FILE:data/x.db',
    ':memory:',
  ])('supports %s', (url) => {
    expect(isSupportedDatabaseUrl(url)).toBe(true);
  });

  it.each(['postgres://user:secret@db/app', 'data/x.db', 'ftp://host/db', ':MEMORY:', ''])(
    'does not support %j',
    (url) => {
      expect(isSupportedDatabaseUrl(url)).toBe(false);
    },
  );
});

describe('databaseLocationFromEnv', () => {
  it('prefers the trimmed remote URL, with its token', () => {
    expect(
      databaseLocationFromEnv({
        TURSO_DATABASE_URL: ' libsql://db-org.turso.io ',
        TURSO_AUTH_TOKEN: ' token ',
        DATABASE_PATH: 'data/ignored.db',
      }),
    ).toEqual({ source: 'TURSO_DATABASE_URL', url: 'libsql://db-org.turso.io', authToken: 'token' });
  });

  it('falls back to the database file as an absolute file: URL', () => {
    expect(databaseLocationFromEnv({ DATABASE_PATH: 'data/my decks.db' })).toEqual({
      source: 'DATABASE_PATH',
      url: pathToFileURL(resolve('data/my decks.db')).href,
      authToken: undefined,
    });
  });

  it.each([{}, { DATABASE_PATH: '' }, { TURSO_DATABASE_URL: '  ', TURSO_AUTH_TOKEN: 'orphan' }])(
    'uses the default file for unset or empty values (%j)',
    (env) => {
      expect(databaseLocationFromEnv(env)).toEqual({
        source: 'DATABASE_PATH',
        url: pathToFileURL(resolve(DEFAULT_DATABASE_PATH)).href,
        authToken: undefined,
      });
    },
  );
});
