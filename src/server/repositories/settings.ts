/**
 * Installation settings: a small key/value store for per-installation values (e.g. the
 * setup code of an unclaimed installation). Keys are defined next to the code that
 * reads them.
 */
import { eq } from 'drizzle-orm';

import { appSettings } from '@/server/db/schema';

import { withTransaction, write, type LibsqlExecutor, type RepositoryContext } from './context';
import { RepositoryError } from './errors';

/** Setting keys: lowercase identifiers such as `setup-code`. */
const SETTING_KEY = /^[a-z][a-z0-9._-]{0,63}$/;

export interface SettingsRepository {
  /** The value of `key`, or `null` when it was never set. */
  get(key: string): Promise<string | null>;
  /**
   * Creates or replaces the value of `key`.
   * @throws {RepositoryError} `invalid-input` for an invalid key.
   */
  set(key: string, value: string): Promise<void>;
  /**
   * The value of `key`; when it is not set yet, stores `create()` first. Atomic: when
   * several callers (or processes) race, exactly one value is stored and every caller
   * gets that value. `create` is only called when the key is missing (again, should the
   * transaction be retried), so it must be free of side effects.
   * @throws {RepositoryError} `invalid-input` for an invalid key.
   */
  getOrCreate(key: string, create: () => string): Promise<string>;
  /** Removes `key`. Returns whether it was set. */
  delete(key: string): Promise<boolean>;
}

export function createSettingsRepository(ctx: RepositoryContext): SettingsRepository {
  const read = async (db: LibsqlExecutor, key: string): Promise<string | null> => {
    const row = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .get();
    return row?.value ?? null;
  };

  return {
    get(key) {
      return read(ctx.db, key);
    },

    async set(key, value) {
      requireValidKey(key);
      const updatedAt = ctx.now();
      await write(ctx, (db) =>
        db
          .insert(appSettings)
          .values({ key, value, updatedAt })
          .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt } }),
      );
    },

    async getOrCreate(key, create) {
      requireValidKey(key);
      const existing = await read(ctx.db, key);
      if (existing !== null) return existing;
      // IMMEDIATE transaction: the write lock is held from the re-check to the insert, so
      // a concurrent creator (another process) either committed before (and wins) or
      // waits for us. `onConflictDoNothing` keeps the first value even if it did not.
      return withTransaction(ctx, async ({ db }) => {
        const raced = await read(db, key);
        if (raced !== null) return raced;
        await db
          .insert(appSettings)
          .values({ key, value: create(), updatedAt: ctx.now() })
          .onConflictDoNothing();
        const stored = await read(db, key);
        if (stored === null) throw new Error(`Setting ${key} was not stored`);
        return stored;
      });
    },

    async delete(key) {
      const result = await write(ctx, (db) => db.delete(appSettings).where(eq(appSettings.key, key)));
      return result.rowsAffected > 0;
    },
  };
}

function requireValidKey(key: string): void {
  if (!SETTING_KEY.test(key)) {
    throw new RepositoryError('invalid-input', `Invalid setting key ${JSON.stringify(key)}`);
  }
}
