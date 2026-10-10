/**
 * The app's migrations on a remote libSQL server: they apply unchanged (including the
 * hand-written trigger migration), the triggers fire, foreign keys and cascades work.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibsqlDatabase } from '@/server/db/libsql';
import {
  applyMigrations,
  assertMigrationsUpToDate,
  bundledMigrations,
  checkMigrationState,
} from '@/server/db/migration-state';
import * as schema from '@/server/db/schema';
import { classifySqlError } from '@/server/db/sql-errors';
import { countRows, seedDeckHistory } from '@tests/support/libsql';

import { openRemote, wipeRemoteDatabase } from './support';

let handle: LibsqlDatabase;

beforeAll(async () => {
  await wipeRemoteDatabase();
  handle = await openRemote();
});

afterAll(() => {
  handle.close();
});

describe('migrations on a remote database', () => {
  it('take an empty database from missing to up to date, once', async () => {
    const { db } = handle;
    const all = bundledMigrations().map((entry) => entry.tag);
    await expect(checkMigrationState(db)).resolves.toMatchObject({ status: 'missing', pending: all });

    const execute = vi.spyOn(handle.client, 'execute');
    const ranIntegrityCheck = (): boolean =>
      execute.mock.calls.some(([statement]) => JSON.stringify(statement).includes('foreign_key_check'));
    const first = await applyMigrations(db);
    expect(first.applied).toEqual(all);
    expect(ranIntegrityCheck()).toBe(true);

    execute.mockClear();
    const second = await applyMigrations(db);
    expect(second.applied).toEqual([]);
    expect(ranIntegrityCheck()).toBe(false);
    await expect(assertMigrationsUpToDate(db)).resolves.toMatchObject({ status: 'up-to-date' });
  });

  it('store the triggers intact, and they fire', async () => {
    const { db } = handle;
    const triggers = await db.all<{ name: string; sql: string }>(
      sql`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name`,
    );
    expect(triggers.find((trigger) => trigger.name === 'commits_immutable_delete')?.sql).toContain(
      "SELECT RAISE(ABORT, 'commits are immutable; delete the deck to remove its history');",
    );

    const seeded = await seedDeckHistory(db, 'remote-deck');
    const update = await db
      .update(schema.snapshots)
      .set({ canonicalJson: '[]' })
      .where(eq(schema.snapshots.hash, seeded.snapshotHash))
      .catch((error: unknown) => error);
    expect(classifySqlError(update)).toEqual({
      kind: 'trigger',
      message: 'snapshots are immutable',
      retryable: false,
      code: 'SQLITE_CONSTRAINT',
    });
    const deleteCommit = await db
      .delete(schema.commits)
      .where(eq(schema.commits.id, seeded.commitId))
      .catch((error: unknown) => error);
    expect(classifySqlError(deleteCommit)).toMatchObject({
      kind: 'trigger',
      message: 'commits are immutable; delete the deck to remove its history',
    });
  });

  it('enforce foreign keys and cascade deck deletion', async () => {
    const { db } = handle;
    const seeded = await seedDeckHistory(db, 'cascading-deck');
    const dangling = await db
      .insert(schema.branches)
      .values({
        id: 'orphan',
        deckId: 'no-such-deck',
        name: 'main',
        kind: 'main',
        createdAt: 'x',
        updatedAt: 'x',
      })
      .catch((error: unknown) => error);
    expect(classifySqlError(dangling).kind).toBe('foreign-key');

    const commitsBefore = await countRows(db, 'commits');
    await db.delete(schema.decks).where(eq(schema.decks.id, seeded.deckId));
    expect(await countRows(db, 'commits')).toBe(commitsBefore - 1);
    expect(await db.all(sql`SELECT id FROM branches WHERE deck_id = ${seeded.deckId}`)).toEqual([]);
    expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });
});
