/**
 * Opening a remote libSQL database: HTTP only, no native code, foreign keys enforced, and
 * the PRAGMAs a local database gets are rejected remotely.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLibsqlDatabase, type LibsqlDatabase } from '@/server/db/libsql';
import { classifySqlError } from '@/server/db/sql-errors';
import { probeDatabaseEntryInChildProcess } from '@tests/support/libsql';

import { openRemote, remoteTarget } from './support';

let handle: LibsqlDatabase;

beforeAll(async () => {
  handle = await openRemote();
});

afterAll(() => {
  handle.close();
});

async function pragma(statement: string): Promise<unknown> {
  const result = await handle.client.execute(statement);
  return result.rows[0]?.[0];
}

describe('a remote libSQL database', () => {
  it('is opened over HTTP and enforces foreign keys', async () => {
    expect(handle.kind).toBe('remote');
    expect(handle.client.protocol).toBe('http');
    expect(await pragma('PRAGMA foreign_keys')).toBe(1);
    expect(await pragma('PRAGMA journal_mode')).toBe('wal');
  });

  it('rejects the per-connection PRAGMAs that only local databases get', async () => {
    for (const statement of ['PRAGMA busy_timeout = 1000', 'PRAGMA journal_mode = WAL']) {
      const error = await handle.client.execute(statement).catch((caught: unknown) => caught);
      expect(classifySqlError(error), statement).toMatchObject({
        kind: 'other',
        code: 'SQL_PARSE_ERROR',
        message: `SQL string could not be parsed: unsupported statement: ${statement}`,
      });
    }
  });

  it('is reachable through a ws: URL as well (served over HTTP)', async () => {
    const { url, authToken } = remoteTarget();
    if (!/^https?:/.test(url)) return;
    const viaWs = await createLibsqlDatabase({ url: url.replace(/^http/, 'ws'), authToken });
    try {
      expect(viaWs.client.protocol).toBe('http');
      expect(viaWs.writeLock).toBe(handle.writeLock);
      const result = await viaWs.client.execute('SELECT 1 AS one');
      expect(result.rows[0]?.[0]).toBe(1);
    } finally {
      viaWs.close();
    }
  });

  it('loads no native module (as in a serverless function)', async () => {
    const { url, authToken } = remoteTarget();
    const probe = await probeDatabaseEntryInChildProcess(url, authToken);
    expect(probe).toEqual({ kind: 'remote', foreignKeys: 1, nativeModules: [] });
  });
});
