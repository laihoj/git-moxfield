import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { countRows, seedDeckHistory, tempDir, tempFileUrl } from '@tests/support/libsql';

import { createLibsqlDatabase, type LibsqlDatabase } from './libsql';
import {
  applyMigrations,
  assertMigrationsUpToDate,
  bundledMigrations,
  checkMigrationState,
  DEFAULT_MIGRATIONS_FOLDER,
  describeMigrationState,
  MigrationStateError,
  parseMigrationJournal,
  readMigrationJournal,
  type MigrationJournalEntry,
} from './migration-state';
import * as schema from './schema';
import { classifySqlError } from './sql-errors';

/** Hand-written triggers that enforce immutable history (drizzle/0001). */
const IMMUTABILITY_TRIGGERS = [
  'commits_immutable_delete',
  'commits_immutable_update',
  'raw_blobs_immutable_update',
  'snapshot_cards_immutable_update',
  'snapshots_immutable_update',
];

const opened: LibsqlDatabase[] = [];

afterEach(() => {
  for (const handle of opened.splice(0)) handle.close();
});

async function open(url = ':memory:'): Promise<LibsqlDatabase> {
  const handle = await createLibsqlDatabase({ url });
  opened.push(handle);
  return handle;
}

interface ExtraMigration {
  tag: string;
  when: number;
  sql: string;
}

/**
 * A migrations folder with the given entries of the real journal (their SQL files copied)
 * plus extra hand-written migrations.
 */
function migrationsFolder(entries: readonly MigrationJournalEntry[], extra: ExtraMigration[] = []): string {
  const folder = tempDir('git-moxfield-migrations-');
  mkdirSync(join(folder, 'meta'));
  for (const entry of entries) {
    copyFileSync(join(DEFAULT_MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  for (const migration of extra) writeFileSync(join(folder, `${migration.tag}.sql`), migration.sql);
  const journal = {
    version: '7',
    dialect: 'sqlite',
    entries: [...entries, ...extra].map(({ tag, when }, idx) => ({
      idx,
      version: '6',
      when,
      tag,
      breakpoints: true,
    })),
  };
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  return folder;
}

const tags = (entries: readonly MigrationJournalEntry[]): string[] => entries.map((entry) => entry.tag);

describe('bundledMigrations', () => {
  it('is the journal in drizzle/, which the app ships statically', () => {
    const onDisk = readMigrationJournal(DEFAULT_MIGRATIONS_FOLDER);
    expect(bundledMigrations()).toEqual(onDisk);
    expect(tags(bundledMigrations()).slice(0, 2)).toEqual(['0000_init', '0001_immutability_triggers']);
  });

  it('rejects anything that is not a journal', () => {
    expect(() => parseMigrationJournal({ entries: [{ tag: 'x' }] }, 'bad.json')).toThrow(
      'bad.json is not a Drizzle migration journal',
    );
    expect(() => parseMigrationJournal(null, 'null.json')).toThrow(/not a Drizzle migration journal/);
  });
});

describe.each([
  ['in memory', () => ':memory:'],
  ['in a file', () => tempFileUrl()],
])('migrations %s', (_, url) => {
  it('takes a new database from missing to up to date, once', async () => {
    const handle = await open(url());
    const all = bundledMigrations();
    expect(await checkMigrationState(handle.db)).toEqual({
      status: 'missing',
      applied: 0,
      expected: all.length,
      pending: tags(all),
      unknown: 0,
    });

    const execute = vi.spyOn(handle.client, 'execute');
    const first = await applyMigrations(handle.db);
    expect(first.applied).toEqual(tags(all));
    expect(first.state).toEqual({
      status: 'up-to-date',
      applied: all.length,
      expected: all.length,
      pending: [],
      unknown: 0,
    });
    const ranIntegrityCheck = (): boolean =>
      execute.mock.calls.some(([statement]) => JSON.stringify(statement).includes('foreign_key_check'));
    expect(ranIntegrityCheck()).toBe(true);

    execute.mockClear();
    const second = await applyMigrations(handle.db);
    expect(second.applied).toEqual([]);
    expect(second.state.status).toBe('up-to-date');
    expect(ranIntegrityCheck()).toBe(false);
    await expect(assertMigrationsUpToDate(handle.db)).resolves.toMatchObject({ status: 'up-to-date' });
  });

  it('applies the hand-written trigger migration unchanged; triggers fire and cascades work', async () => {
    const { db } = await open(url());
    await applyMigrations(db);
    const triggers = await db.all<{ name: string; sql: string }>(
      sql`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name`,
    );
    expect(triggers.map((trigger) => trigger.name)).toEqual(expect.arrayContaining(IMMUTABILITY_TRIGGERS));
    expect(triggers.find((trigger) => trigger.name === 'commits_immutable_delete')?.sql).toContain(
      "SELECT RAISE(ABORT, 'commits are immutable; delete the deck to remove its history');",
    );

    const seeded = await seedDeckHistory(db);
    const update = await db
      .update(schema.commits)
      .set({ message: 'rewritten' })
      .where(eq(schema.commits.id, seeded.commitId))
      .catch((error: unknown) => error);
    expect(classifySqlError(update)).toMatchObject({ kind: 'trigger', message: 'commits are immutable' });
    const deleteCommit = await db
      .delete(schema.commits)
      .where(eq(schema.commits.id, seeded.commitId))
      .catch((error: unknown) => error);
    expect(classifySqlError(deleteCommit).kind).toBe('trigger');

    // Deleting the deck takes its history with it (ON DELETE CASCADE; the trigger allows it).
    await db.delete(schema.decks).where(eq(schema.decks.id, seeded.deckId));
    expect(await countRows(db, 'branches')).toBe(0);
    expect(await countRows(db, 'commits')).toBe(0);
    expect(await countRows(db, 'snapshots')).toBe(1);
    expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });
});

describe('applyMigrations on a populated database', () => {
  it('upgrades it without losing or orphaning rows', async () => {
    const all = bundledMigrations();
    const { db } = await open(tempFileUrl());
    await applyMigrations(db, { migrationsFolder: migrationsFolder(all.slice(0, 2)) });
    const seeded = await seedDeckHistory(db);
    // The catalog before 0005 made it per workspace.
    await db.run(sql`
      INSERT INTO card_catalog (key, name, type_line, primary_type, mana_cost, cmc, color_identity_json, layout)
      VALUES ('sol ring', 'Sol Ring', 'Artifact', 'Artifact', '{1}', 1, '[]', 'normal')`);

    const upgrade = await applyMigrations(db);
    expect(upgrade.applied).toEqual(tags(all.slice(2)));
    for (const table of ['decks', 'branches', 'commits', 'snapshots', 'snapshot_cards']) {
      expect(await countRows(db, table), table).toBe(1);
    }
    expect(await db.all(sql`SELECT workspace_id AS workspaceId, key FROM card_catalog`)).toEqual([
      { workspaceId: seeded.workspaceId, key: 'sol ring' },
    ]);
    const update = await db
      .update(schema.commits)
      .set({ message: 'rewritten' })
      .where(eq(schema.commits.id, seeded.commitId))
      .catch((error: unknown) => error);
    expect(classifySqlError(update).kind).toBe('trigger');
  });
});

describe('checkMigrationState', () => {
  it('reports a database that is behind, and applyMigrations catches it up', async () => {
    const all = bundledMigrations();
    const older = all.slice(0, -2);
    const { db } = await open();
    const partial = await applyMigrations(db, { migrationsFolder: migrationsFolder(older) });
    expect(partial.applied).toEqual(tags(older));

    const state = await checkMigrationState(db);
    expect(state).toEqual({
      status: 'behind',
      applied: older.length,
      expected: all.length,
      pending: tags(all.slice(-2)),
      unknown: 0,
    });
    expect(describeMigrationState(state)).toContain(
      `2 migrations behind (${tags(all.slice(-2)).join(', ')})`,
    );
    await expect(assertMigrationsUpToDate(db)).rejects.toBeInstanceOf(MigrationStateError);

    const rest = await applyMigrations(db);
    expect(rest.applied).toEqual(tags(all.slice(-2)));
    expect(rest.state.status).toBe('up-to-date');
  });

  it('reports a database migrated by a newer build as ahead, and refuses to migrate it', async () => {
    const all = bundledMigrations();
    const { db } = await open();
    await applyMigrations(db);
    const olderBuild = all.slice(0, -1);

    const state = await checkMigrationState(db, olderBuild);
    expect(state).toEqual({
      status: 'ahead',
      applied: all.length,
      expected: olderBuild.length,
      pending: [],
      unknown: 1,
    });
    expect(describeMigrationState(state)).toMatch(/newer version of git-moxfield \(1 unknown migration\)/);

    const failure = applyMigrations(db, { migrationsFolder: migrationsFolder(olderBuild) });
    await expect(failure).rejects.toBeInstanceOf(MigrationStateError);
    await expect(failure).rejects.toMatchObject({ state: { status: 'ahead' } });
    expect(await countRows(db, '__drizzle_migrations')).toBe(all.length);
  });

  it('treats an empty migrations table as missing', async () => {
    const { db } = await open();
    await db.run(
      sql`CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
    );
    await expect(checkMigrationState(db)).resolves.toMatchObject({ status: 'missing', applied: 0 });
    await expect(assertMigrationsUpToDate(db)).rejects.toThrow(/not been migrated yet/);
  });
});

describe('applyMigrations', () => {
  it('fails when the migrated data violates foreign keys', async () => {
    const all = bundledMigrations();
    const last = all.at(-1)?.when ?? 0;
    const folder = migrationsFolder(all, [
      {
        tag: '9999_dangling_reference',
        when: last + 1,
        sql:
          'CREATE TABLE parent (id TEXT PRIMARY KEY);\n--> statement-breakpoint\n' +
          'CREATE TABLE child (parent_id TEXT REFERENCES parent(id));\n--> statement-breakpoint\n' +
          "INSERT INTO child VALUES ('missing');",
      },
    ]);
    const { db } = await open();
    await expect(applyMigrations(db, { migrationsFolder: folder })).rejects.toThrow(
      /1 foreign key violation after migrating \(in child\)/,
    );
  });

  it('fails when a pending migration is older than the newest applied one', async () => {
    const all = bundledMigrations();
    const { db } = await open();
    await applyMigrations(db);
    const first = all[0]?.when ?? 0;
    const folder = migrationsFolder(all, [
      { tag: '0000_backdated', when: first - 1, sql: 'CREATE TABLE backdated (n INTEGER);' },
    ]);
    const failure = applyMigrations(db, { migrationsFolder: folder });
    await expect(failure).rejects.toBeInstanceOf(MigrationStateError);
    await expect(failure).rejects.toThrow(/0000_backdated.*older than the newest/s);
  });
});
