import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

import { createClient as createHttpClient } from '@libsql/client/http';
import { createClient as createLocalClient } from '@libsql/client/sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle as drizzleRoot } from 'drizzle-orm/libsql';
import { drizzle as drizzleRemote } from 'drizzle-orm/libsql/http';
import { drizzle as drizzleLocal } from 'drizzle-orm/libsql/sqlite3';
import { describe, expect, it } from 'vitest';

import {
  openRawDatabase,
  probeDatabaseEntryInChildProcess,
  scratchDir,
  startHranaStub,
} from '@tests/support/libsql';

import {
  createLibsqlDatabase,
  DatabaseConfigError,
  databaseFileOf,
  databaseKindOf,
  describeDatabaseUrl,
  type LibsqlDatabase,
  type LibsqlDb,
} from './libsql';
import * as schema from './schema';
import { classifySqlError } from './sql-errors';

/** The classified message of the error `operation` rejects with. */
async function failureMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return classifySqlError(error).message;
  }
  throw new Error('expected the operation to fail');
}

async function pragma(handle: LibsqlDatabase, name: string): Promise<unknown> {
  const result = await handle.client.execute(`PRAGMA ${name}`);
  return result.rows[0]?.[0];
}

describe('createLibsqlDatabase', () => {
  describe('in memory', () => {
    it('opens a private local database with foreign keys enforced', async () => {
      const a = await openRawDatabase({ url: ':memory:' });
      const b = await openRawDatabase({ url: 'file::memory:' });
      expect(a.kind).toBe('local');
      expect(a.db.$client).toBe(a.client);
      expect(await pragma(a, 'foreign_keys')).toBe(1);
      expect(await pragma(a, 'journal_mode')).toBe('memory');

      await a.db.run(sql`CREATE TABLE only_in_a (n INTEGER)`);
      expect(await failureMessage(b.db.run(sql`SELECT * FROM only_in_a`))).toBe('no such table: only_in_a');
      expect(a.writeLock).not.toBe(b.writeLock);
    });

    it('closes idempotently', async () => {
      const handle = await openRawDatabase({ url: ':memory:' });
      handle.close();
      handle.close();
      expect(handle.client.closed).toBe(true);
      expect(await failureMessage(handle.db.run(sql`SELECT 1`))).toBe('The client is closed');
    });
  });

  describe('files', () => {
    it('creates missing directories, uses write-ahead logging and keeps data across reopening', async () => {
      const file = join(scratchDir(), 'nested', 'dir', 'app.db');
      const first = await openRawDatabase({ url: `file:${file}` });
      expect(first.kind).toBe('local');
      expect(await pragma(first, 'journal_mode')).toBe('wal');
      expect(await pragma(first, 'foreign_keys')).toBe(1);
      await first.db.run(sql`CREATE TABLE kept (n INTEGER)`);
      await first.db.run(sql`INSERT INTO kept VALUES (42)`);
      expect(existsSync(`${file}-wal`)).toBe(true);
      first.close();

      const second = await openRawDatabase({ url: `file://${file}` });
      expect(await second.db.all(sql`SELECT n FROM kept`)).toEqual([{ n: 42 }]);
    });

    it('shares one write lock between all handles on the same file', async () => {
      const directory = scratchDir();
      const file = join(directory, 'shared.db');
      const absolute = await openRawDatabase({ url: `file:${file}` });
      const viaRelativePath = await openRawDatabase({ url: `file:${relative(process.cwd(), file)}` });
      const viaAuthority = await openRawDatabase({ url: `file:///${file.replace(/^\//, '')}` });
      const other = await openRawDatabase({ url: `file:${join(directory, 'other.db')}` });
      expect(viaRelativePath.writeLock).toBe(absolute.writeLock);
      expect(viaAuthority.writeLock).toBe(absolute.writeLock);
      expect(other.writeLock).not.toBe(absolute.writeLock);
      expect(absolute.writeLock.name).toBe(`file:${file}`);
    });

    it('relies on libSQL enforcing foreign keys on every pooled connection', async () => {
      // A PRAGMA cannot reach every connection of the pool; the build default must do it.
      const url = `file:${join(scratchDir(), 'pool.db')}`;
      await openRawDatabase({ url });
      const raw = createLocalClient({ url });
      try {
        const transaction = await raw.transaction('write'); // holds one connection
        const other = await raw.execute('PRAGMA foreign_keys'); // runs on another
        await transaction.rollback();
        expect(other.rows[0]?.[0]).toBe(1);
      } finally {
        raw.close();
      }
    });
  });

  describe('remote', () => {
    it('opens a libSQL server over HTTP and checks that it enforces foreign keys', async () => {
      const server = await startHranaStub();
      const handle = await openRawDatabase({ url: server.url });
      expect(handle.kind).toBe('remote');
      expect(handle.client.protocol).toBe('http');
      expect(await pragma(handle, 'foreign_keys')).toBe(1);
      expect(server.requests()).toBeGreaterThan(0);
    });

    it('serves ws: and wss: URLs over HTTP on the same host and port', async () => {
      const server = await startHranaStub();
      const handle = await openRawDatabase({ url: server.url.replace(/^http:/, 'ws:') });
      expect(handle.kind).toBe('remote');
      expect(handle.client.protocol).toBe('http');
      expect(await pragma(handle, 'foreign_keys')).toBe(1);
    });

    it('refuses a server that does not enforce foreign keys', async () => {
      const server = await startHranaStub({ foreignKeys: 0 });
      const failure = createLibsqlDatabase({ url: server.url });
      await expect(failure).rejects.toBeInstanceOf(DatabaseConfigError);
      await expect(failure).rejects.toThrow(/does not enforce foreign keys.*--tursodb/s);
    });

    it('loads no native module in a process that only opens remote databases', async () => {
      const server = await startHranaStub();
      const remote = await probeDatabaseEntryInChildProcess(server.url);
      expect(remote).toEqual({ kind: 'remote', foreignKeys: 1, nativeModules: [] });

      // The probe does see the native binding when a local database is opened.
      const local = await probeDatabaseEntryInChildProcess(':memory:');
      expect(local.kind).toBe('local');
      expect(local.nativeModules.some((path) => path.endsWith('.node'))).toBe(true);
    }, 60_000);
  });

  it('rejects unsupported URLs without echoing them', async () => {
    for (const url of ['postgres://user:hunter2@host/db', 'hunter2', 'file:', '']) {
      const failure = createLibsqlDatabase({ url });
      await expect(failure).rejects.toBeInstanceOf(DatabaseConfigError);
      await expect(failure).rejects.not.toThrow(/hunter2/);
    }
  });
});

describe('databaseKindOf and describeDatabaseUrl', () => {
  it.each([
    ['libsql://app-org.turso.io', 'remote', 'remote database app-org.turso.io'],
    ['libsql://app-org.turso.io?authToken=secret', 'remote', 'remote database app-org.turso.io'],
    ['https://user:secret@app-org.turso.io/', 'remote', 'remote database app-org.turso.io'],
    ['http://127.0.0.1:8080', 'remote', 'remote database 127.0.0.1:8080'],
    ['wss://app-org.turso.io', 'remote', 'remote database app-org.turso.io'],
    ['ws://127.0.0.1:8080', 'remote', 'remote database 127.0.0.1:8080'],
    [':memory:', 'local', 'in-memory database'],
    ['file::memory:', 'local', 'in-memory database'],
    ['file:/data/app.db', 'local', 'database file /data/app.db'],
    ['file:///data/app.db', 'local', 'database file /data/app.db'],
  ])('%s is %s (%s)', (url, kind, description) => {
    expect(databaseKindOf(url)).toBe(kind);
    expect(describeDatabaseUrl(url)).toBe(description);
  });

  it('resolves relative file paths against the working directory', () => {
    expect(describeDatabaseUrl('file:data/app.db')).toBe(
      `database file ${join(process.cwd(), 'data/app.db')}`,
    );
  });

  it('throws for other schemes', () => {
    expect(() => databaseKindOf('mysql://host/db')).toThrow(DatabaseConfigError);
    expect(() => databaseKindOf('data/app.db')).toThrow(/Unsupported database URL/);
  });
});

describe('databaseFileOf', () => {
  it.each([
    ['file:/data/app.db', '/data/app.db'],
    ['file:///data/my%20decks.db', '/data/my decks.db'],
    ['file:data/app.db', join(process.cwd(), 'data/app.db')],
    [':memory:', undefined],
    ['file::memory:', undefined],
    ['libsql://app-org.turso.io', undefined],
    ['http://127.0.0.1:8080', undefined],
  ])('%s → %s', (url, file) => {
    expect(databaseFileOf(url)).toBe(file);
  });

  it('throws for other schemes', () => {
    expect(() => databaseFileOf('data/app.db')).toThrow(DatabaseConfigError);
  });
});

describe('LibsqlDb', () => {
  it('is the type of every Drizzle libSQL entry, local and remote', () => {
    const local = createLocalClient({ url: ':memory:' });
    try {
      // Compile-time checks: each entry's database is assignable to LibsqlDb.
      const fromLocalEntry: LibsqlDb = drizzleLocal({ client: local, schema });
      const fromRootEntry: LibsqlDb = drizzleRoot({ client: local, schema });
      const fromRemoteEntry: LibsqlDb = drizzleRemote({
        client: createHttpClient({ url: 'http://127.0.0.1:9' }),
        schema,
      });
      expect(
        [fromLocalEntry, fromRootEntry, fromRemoteEntry].every((db) => typeof db.select === 'function'),
      ).toBe(true);
    } finally {
      local.close();
    }
  });
});
