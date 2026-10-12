import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibsqlDatabase, LibsqlExecutor } from '@/server/db/libsql';
import { createRepositories } from '@/server/repositories';
import {
  countRows,
  createTestRepositories,
  expectRepositoryError,
  openTestDatabaseHandle,
} from '@tests/support/db';
import { scratchDir } from '@tests/support/libsql';

interface SettingRow {
  key: string;
  value: string;
  updated_at: string;
}

function settingRows(db: LibsqlExecutor): Promise<SettingRow[]> {
  return db.all<SettingRow>(sql`SELECT key, value, updated_at FROM app_settings ORDER BY key`);
}

describe('settings repository', () => {
  it('returns null for a setting that was never set', async () => {
    const { repos } = await createTestRepositories();
    expect(await repos.settings.get('capture-token')).toBeNull();
  });

  it('creates and replaces values, recording when they changed', async () => {
    const { db, repos } = await createTestRepositories();

    await repos.settings.set('theme', 'dark');
    expect(await repos.settings.get('theme')).toBe('dark');
    const created = (await settingRows(db))[0]?.updated_at ?? '';

    await repos.settings.set('theme', 'light');
    expect(await repos.settings.get('theme')).toBe('light');
    const replaced = (await settingRows(db))[0]?.updated_at ?? '';
    expect(await countRows(db, 'app_settings')).toBe(1);
    expect(created).not.toBe('');
    expect(replaced > created).toBe(true);
  });

  it('rejects invalid keys', async () => {
    const { repos } = await createTestRepositories();
    for (const key of ['', 'Capture-Token', '1st', 'with space', 'x'.repeat(65)]) {
      await expectRepositoryError(repos.settings.set(key, 'value'), 'invalid-input');
      await expectRepositoryError(() => repos.settings.getOrCreate(key, () => 'value'), 'invalid-input');
    }
  });

  describe('getOrCreate', () => {
    it('creates the value once and returns it from then on', async () => {
      const { db, repos } = await createTestRepositories();
      const create = vi.fn(() => 'first');

      expect(await repos.settings.getOrCreate('capture-token', create)).toBe('first');
      expect(await repos.settings.getOrCreate('capture-token', () => 'second')).toBe('first');
      expect(await repos.settings.get('capture-token')).toBe('first');
      expect(create).toHaveBeenCalledTimes(1);
      expect(await settingRows(db)).toEqual([
        { key: 'capture-token', value: 'first', updated_at: expect.any(String) as string },
      ]);
    });

    it('keeps a value that was set before', async () => {
      const { repos } = await createTestRepositories();
      await repos.settings.set('capture-token', 'preset');
      const create = vi.fn(() => 'created');
      expect(await repos.settings.getOrCreate('capture-token', create)).toBe('preset');
      expect(create).not.toHaveBeenCalled();
    });

    it('works inside a transaction and is rolled back with it', async () => {
      const { repos } = await createTestRepositories();
      await expect(
        repos.transaction(async (tx) => {
          expect(await tx.settings.getOrCreate('capture-token', () => 'doomed')).toBe('doomed');
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      expect(await repos.settings.get('capture-token')).toBeNull();
    });

    it('does not store anything when creating the value fails', async () => {
      const { db, repos } = await createTestRepositories();
      await expect(
        repos.settings.getOrCreate('capture-token', () => {
          throw new Error('no entropy');
        }),
      ).rejects.toThrow('no entropy');
      expect(await countRows(db, 'app_settings')).toBe(0);
    });

    describe('with several connections to one database file', () => {
      let dir: string;

      beforeEach(() => {
        dir = scratchDir('git-moxfield-settings-');
      });

      function connect(): Promise<LibsqlDatabase> {
        return openTestDatabaseHandle({ url: `file:${join(dir, 'settings.db')}` });
      }

      it('agrees on the first value stored, also after reopening the database', async () => {
        const [firstHandle, secondHandle] = [await connect(), await connect()];
        const first = createRepositories(firstHandle.db);
        const second = createRepositories(secondHandle.db);

        expect(await first.settings.getOrCreate('capture-token', () => 'from-first')).toBe('from-first');
        expect(await second.settings.getOrCreate('capture-token', () => 'from-second')).toBe('from-first');

        firstHandle.close();
        secondHandle.close();
        const reopened = createRepositories((await connect()).db);
        expect(await reopened.settings.getOrCreate('capture-token', () => 'after-restart')).toBe(
          'from-first',
        );
      });

      it('stores exactly one value when connections race', async () => {
        const [first, second] = await Promise.all([connect(), connect()]);
        const values = await Promise.all(
          ['a', 'b', 'c', 'd'].map((value, i) =>
            createRepositories((i % 2 === 0 ? first : second).db).settings.getOrCreate(
              'capture-token',
              () => value,
            ),
          ),
        );
        expect(new Set(values).size).toBe(1);
        expect(await countRows(first.db, 'app_settings')).toBe(1);
      });
    });
  });
});
