/**
 * Installation settings: a small key/value store for per-installation values and
 * secrets (e.g. the capture token baked into the same-tab bookmarklet). Keys are
 * defined next to the code that reads them.
 */
import { eq } from 'drizzle-orm';

import { appSettings } from '@/server/db/schema';

import { withTransaction, type RepositoryContext } from './context';
import { RepositoryError } from './errors';

/** Setting keys: lowercase identifiers such as `capture-token`. */
const SETTING_KEY = /^[a-z][a-z0-9._-]{0,63}$/;

export interface SettingsRepository {
  /** The value of `key`, or `null` when it was never set. */
  get(key: string): string | null;
  /**
   * Creates or replaces the value of `key`.
   * @throws {RepositoryError} `invalid-input` for an invalid key.
   */
  set(key: string, value: string): void;
  /**
   * The value of `key`; when it is not set yet, stores `create()` first. Atomic: when
   * several callers (or processes) race, exactly one value is stored and every caller
   * gets that value. `create` is only called when the key is missing.
   * @throws {RepositoryError} `invalid-input` for an invalid key.
   */
  getOrCreate(key: string, create: () => string): string;
}

export function createSettingsRepository(ctx: RepositoryContext): SettingsRepository {
  const read = (db: RepositoryContext['db'], key: string): string | null =>
    db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).get()?.value ??
    null;

  return {
    get(key) {
      return read(ctx.db, key);
    },

    set(key, value) {
      requireValidKey(key);
      const updatedAt = ctx.now();
      ctx.db
        .insert(appSettings)
        .values({ key, value, updatedAt })
        .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt } })
        .run();
    },

    getOrCreate(key, create) {
      requireValidKey(key);
      const existing = read(ctx.db, key);
      if (existing !== null) return existing;
      // IMMEDIATE transaction: the write lock is held from the re-check to the insert, so
      // a concurrent creator (another connection) either committed before (and wins) or
      // waits for us. `onConflictDoNothing` keeps the first value even if it did not.
      return withTransaction(ctx, ({ db }) => {
        const raced = read(db, key);
        if (raced !== null) return raced;
        db.insert(appSettings)
          .values({ key, value: create(), updatedAt: ctx.now() })
          .onConflictDoNothing()
          .run();
        const stored = read(db, key);
        if (stored === null) throw new Error(`Setting ${key} was not stored`);
        return stored;
      });
    },
  };
}

function requireValidKey(key: string): void {
  if (!SETTING_KEY.test(key)) {
    throw new RepositoryError('invalid-input', `Invalid setting key ${JSON.stringify(key)}`);
  }
}
