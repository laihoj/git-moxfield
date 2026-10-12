/**
 * `getAuthService()`: the process-wide auth service over the app's database, rebuilt when
 * the database is opened again, and the setup code of an unclaimed installation announced
 * once per process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as DbClientModule from '@/server/db/client';
import type { LibsqlDb } from '@/server/db/libsql';
import { openTestDatabase } from '@tests/support/db';
import type { LogEntry } from '@tests/support/recording-logger';

const state = vi.hoisted(() => ({
  getDb: undefined as (() => Promise<LibsqlDb>) | undefined,
  logs: [] as LogEntry[],
}));

vi.mock('@/server/db/client', async (importOriginal) => ({
  ...(await importOriginal<typeof DbClientModule>()),
  getDb: () => {
    if (state.getDb === undefined) throw new Error('No database for this test');
    return state.getDb();
  },
}));
vi.mock('@/server/logger', async () =>
  (await import('@tests/support/recording-logger')).recordingLoggerModule(state.logs),
);

/** The process-wide flag `getAuthService` sets once it announced the setup code. */
const processState = globalThis as { __gitMoxfieldSetupCodeAnnounced?: boolean };

/** A fresh copy of the module (its service cache starts empty). */
async function load() {
  vi.resetModules();
  return import('./index');
}

beforeEach(() => {
  delete processState.__gitMoxfieldSetupCodeAnnounced;
  state.logs.length = 0;
});

afterEach(() => {
  state.getDb = undefined;
  delete processState.__gitMoxfieldSetupCodeAnnounced;
});

function announcements(): string[] {
  return state.logs.filter((entry) => entry.message.includes('setup code')).map((entry) => entry.message);
}

describe('getAuthService', () => {
  it('shares one service per database and builds a new one when the database is reopened', async () => {
    const { getAuthService } = await load();
    let db = await openTestDatabase();
    state.getDb = () => Promise.resolve(db);

    const first = await getAuthService();
    expect(await getAuthService()).toBe(first);

    db = await openTestDatabase();
    const second = await getAuthService();
    expect(second).not.toBe(first);
    expect(await second.isClaimable()).toBe(true);
  });

  it('announces the setup code of an unclaimed installation once per process', async () => {
    const db = await openTestDatabase();
    state.getDb = () => Promise.resolve(db);
    const { getAuthService } = await load();
    const auth = await getAuthService();
    const code = await auth.setupCode();
    expect(announcements()).toEqual([expect.stringContaining(`enter the setup code ${code ?? ''}`)]);

    // Another module instance (a dev-server reload) does not repeat it.
    await (await load()).getAuthService();
    expect(announcements()).toHaveLength(1);
  });

  it('fails while the database cannot be opened, and works once it can', async () => {
    const { getAuthService } = await load();
    state.getDb = () => Promise.reject(new Error('The database has not been migrated yet.'));
    await expect(getAuthService()).rejects.toThrow('not been migrated');

    const db = await openTestDatabase();
    state.getDb = () => Promise.resolve(db);
    expect(await (await getAuthService()).isClaimable()).toBe(true);
  });
});
