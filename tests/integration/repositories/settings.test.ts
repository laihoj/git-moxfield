import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, type Db } from '@/server/db/client';
import { createRepositories } from '@/server/repositories';
import { countRows, createTestRepositories, expectRepositoryError } from '@tests/support/db';

function settingRows(db: Db): { key: string; value: string; updated_at: string }[] {
  return db.$client.prepare('SELECT key, value, updated_at FROM app_settings ORDER BY key').all() as {
    key: string;
    value: string;
    updated_at: string;
  }[];
}

describe('settings repository', () => {
  it('returns null for a setting that was never set', () => {
    const { repos } = createTestRepositories();
    expect(repos.settings.get('capture-token')).toBeNull();
  });

  it('creates and replaces values, recording when they changed', () => {
    const { db, repos } = createTestRepositories();

    repos.settings.set('theme', 'dark');
    expect(repos.settings.get('theme')).toBe('dark');
    const created = settingRows(db)[0]?.updated_at ?? '';

    repos.settings.set('theme', 'light');
    expect(repos.settings.get('theme')).toBe('light');
    const replaced = settingRows(db)[0]?.updated_at ?? '';
    expect(countRows(db, 'app_settings')).toBe(1);
    expect(created).not.toBe('');
    expect(replaced > created).toBe(true);
  });

  it('rejects invalid keys', () => {
    const { repos } = createTestRepositories();
    for (const key of ['', 'Capture-Token', '1st', 'with space', 'x'.repeat(65)]) {
      expectRepositoryError(() => {
        repos.settings.set(key, 'value');
      }, 'invalid-input');
      expectRepositoryError(() => repos.settings.getOrCreate(key, () => 'value'), 'invalid-input');
    }
  });

  describe('getOrCreate', () => {
    it('creates the value once and returns it from then on', () => {
      const { db, repos } = createTestRepositories();
      const create = vi.fn(() => 'first');

      expect(repos.settings.getOrCreate('capture-token', create)).toBe('first');
      expect(repos.settings.getOrCreate('capture-token', () => 'second')).toBe('first');
      expect(repos.settings.get('capture-token')).toBe('first');
      expect(create).toHaveBeenCalledTimes(1);
      expect(settingRows(db)).toEqual([
        { key: 'capture-token', value: 'first', updated_at: expect.any(String) as string },
      ]);
    });

    it('keeps a value that was set before', () => {
      const { repos } = createTestRepositories();
      repos.settings.set('capture-token', 'preset');
      const create = vi.fn(() => 'created');
      expect(repos.settings.getOrCreate('capture-token', create)).toBe('preset');
      expect(create).not.toHaveBeenCalled();
    });

    it('works inside a transaction and is rolled back with it', () => {
      const { repos } = createTestRepositories();
      expect(() =>
        repos.transaction((tx) => {
          expect(tx.settings.getOrCreate('capture-token', () => 'doomed')).toBe('doomed');
          throw new Error('roll back');
        }),
      ).toThrow('roll back');
      expect(repos.settings.get('capture-token')).toBeNull();
    });

    it('does not store anything when creating the value fails', () => {
      const { db, repos } = createTestRepositories();
      expect(() =>
        repos.settings.getOrCreate('capture-token', () => {
          throw new Error('no entropy');
        }),
      ).toThrow('no entropy');
      expect(countRows(db, 'app_settings')).toBe(0);
    });

    describe('with several connections to one database file', () => {
      let dir: string | undefined;
      const open: Db[] = [];

      afterEach(() => {
        for (const db of open.splice(0)) db.$client.close();
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
        dir = undefined;
      });

      function connect(): Db {
        dir ??= mkdtempSync(join(tmpdir(), 'git-moxfield-settings-'));
        const db = openDatabase(join(dir, 'settings.db'));
        open.push(db);
        return db;
      }

      it('agrees on the first value stored, also after reopening the database', () => {
        const first = createRepositories(connect());
        const second = createRepositories(connect());

        expect(first.settings.getOrCreate('capture-token', () => 'from-first')).toBe('from-first');
        expect(second.settings.getOrCreate('capture-token', () => 'from-second')).toBe('from-first');

        for (const db of open.splice(0)) db.$client.close();
        const reopened = createRepositories(connect());
        expect(reopened.settings.getOrCreate('capture-token', () => 'after-restart')).toBe('from-first');
      });
    });
  });
});
