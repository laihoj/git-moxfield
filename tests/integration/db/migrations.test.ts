/**
 * Schema migrations on populated databases. In-memory test databases are always
 * migrated empty, which hides migrations that fail or lose data on existing installs,
 * so these tests upgrade a file database that holds a deck with history.
 */
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '@/server/db/client';
import type { LibsqlDatabase, LibsqlExecutor } from '@/server/db/libsql';
import { createRepositories } from '@/server/repositories';
import { baseDeckSpec, buildSnapshot } from '@tests/support/builders';
import {
  commitTestSnapshot,
  countRows,
  createTestDeck,
  expectDatabaseError,
  observeTestSnapshot,
  openTestDatabase,
} from '@tests/support/db';
import { tempDir } from '@tests/support/libsql';

const MIGRATIONS = join(process.cwd(), 'drizzle');

/** Hand-written triggers that enforce immutable history (drizzle/0001). */
const IMMUTABILITY_TRIGGERS = [
  'commits_immutable_delete',
  'commits_immutable_update',
  'raw_blobs_immutable_update',
  'snapshot_cards_immutable_update',
  'snapshots_immutable_update',
];

const HISTORY_TABLES = [
  'decks',
  'branches',
  'commits',
  'snapshots',
  'snapshot_cards',
  'raw_blobs',
  'observations',
  'version_tags',
  'commit_notes',
];

/**
 * A table rebuild as `drizzle-kit generate` writes it for changes SQLite cannot `ALTER`
 * (column type, default, nullability, foreign keys), plus the trigger statements the
 * migration author has to add because `DROP TABLE` drops a table's triggers.
 */
const REBUILD_SNAPSHOTS = `PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE \`__new_snapshots\` (
	\`hash\` text PRIMARY KEY NOT NULL,
	\`schema_version\` integer DEFAULT 1 NOT NULL,
	\`canonical_json\` text NOT NULL,
	\`created_at\` text NOT NULL
);
--> statement-breakpoint
INSERT INTO \`__new_snapshots\`("hash", "schema_version", "canonical_json", "created_at") SELECT "hash", "schema_version", "canonical_json", "created_at" FROM \`snapshots\`;--> statement-breakpoint
DROP TABLE \`snapshots\`;--> statement-breakpoint
ALTER TABLE \`__new_snapshots\` RENAME TO \`snapshots\`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TRIGGER \`snapshots_immutable_update\` BEFORE UPDATE ON \`snapshots\`
BEGIN
  SELECT RAISE(ABORT, 'snapshots are immutable');
END;`;

/** A rebuild of `decks`, with `commits_immutable_delete` dropped first and recreated after. */
const REBUILD_DECKS = `DROP TRIGGER \`commits_immutable_delete\`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE \`__new_decks\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`workspace_id\` text NOT NULL,
	\`source\` text NOT NULL,
	\`external_id\` text NOT NULL,
	\`url\` text NOT NULL,
	\`name\` text NOT NULL,
	\`format\` text DEFAULT 'commander' NOT NULL,
	\`head_branch_name\` text DEFAULT 'main' NOT NULL,
	\`last_fetch_attempt_at\` text,
	\`last_fetch_error_json\` text,
	\`created_at\` text NOT NULL,
	\`updated_at\` text NOT NULL,
	FOREIGN KEY (\`workspace_id\`) REFERENCES \`workspaces\`(\`id\`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO \`__new_decks\`("id", "workspace_id", "source", "external_id", "url", "name", "format", "head_branch_name", "last_fetch_attempt_at", "last_fetch_error_json", "created_at", "updated_at") SELECT "id", "workspace_id", "source", "external_id", "url", "name", "format", "head_branch_name", "last_fetch_attempt_at", "last_fetch_error_json", "created_at", "updated_at" FROM \`decks\`;--> statement-breakpoint
DROP TABLE \`decks\`;--> statement-breakpoint
ALTER TABLE \`__new_decks\` RENAME TO \`decks\`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX \`decks_workspace_source_external_uq\` ON \`decks\` (\`workspace_id\`,\`source\`,\`external_id\`);--> statement-breakpoint
CREATE TRIGGER \`commits_immutable_delete\` BEFORE DELETE ON \`commits\`
WHEN EXISTS (SELECT 1 FROM \`decks\` WHERE \`id\` = OLD.\`deck_id\`)
BEGIN
  SELECT RAISE(ABORT, 'commits are immutable; delete the deck to remove its history');
END;`;

/** A migration that leaves an observation pointing at a snapshot that does not exist. */
const DANGLING_REFERENCE = `INSERT INTO \`observations\` ("id", "deck_id", "snapshot_hash", "raw_blob_hash", "ingest_method", "fetched_at", "source_metadata_json") SELECT 'dangling', "id", 'no-such-snapshot', 'no-such-blob', 'server', '2026-01-01T00:00:00.000Z', '{}' FROM \`decks\` LIMIT 1;`;

async function sqliteNames(db: LibsqlExecutor, type: 'table' | 'trigger' | 'index'): Promise<string[]> {
  const rows = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = ${type} ORDER BY name`,
  );
  return rows.map((row) => row.name);
}

async function rowCounts(db: LibsqlExecutor): Promise<Record<string, number>> {
  const counts = await Promise.all(HISTORY_TABLES.map(async (table) => [table, await countRows(db, table)]));
  return Object.fromEntries(counts) as Record<string, number>;
}

async function pragma<T>(db: LibsqlExecutor, statement: string): Promise<T[]> {
  return db.all<T>(sql.raw(`PRAGMA ${statement}`));
}

describe('database migrations', () => {
  it('enforces foreign keys and installs the immutability triggers', async () => {
    const db = await openTestDatabase();
    expect(await pragma(db, 'foreign_keys')).toEqual([{ foreign_keys: 1 }]);
    expect(await sqliteNames(db, 'trigger')).toEqual(IMMUTABILITY_TRIGGERS);
  });

  describe('upgrading a database that holds history', () => {
    let dir: string;
    let migrations: string;
    let url: string;
    let before: Record<string, number>;
    const open: LibsqlDatabase[] = [];

    /** Opens (and migrates) a database file with the copied migrations folder. */
    async function openFile(fileUrl: string): Promise<LibsqlDatabase> {
      const handle = await openDatabase({ url: fileUrl, migrationsFolder: migrations });
      open.push(handle);
      return handle;
    }

    /** Adds a migration after the shipped ones to the copied migrations folder. */
    function addMigration(tag: string, statements: string): void {
      const journalPath = join(migrations, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
      };
      const last = journal.entries.at(-1);
      if (!last) throw new Error('The migration journal is empty');
      journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag });
      writeFileSync(journalPath, JSON.stringify(journal, null, 2));
      writeFileSync(join(migrations, `${tag}.sql`), statements);
    }

    /**
     * Truncates the copied journal before migration `tag` (the schema an older build
     * shipped); returns a function that restores the full journal.
     */
    function journalBefore(tag: string): () => void {
      const journalPath = join(migrations, 'meta', '_journal.json');
      const full = readFileSync(journalPath, 'utf8');
      const journal = JSON.parse(full) as { entries: { tag: string }[] };
      const at = journal.entries.findIndex((entry) => entry.tag === tag);
      expect(at).toBeGreaterThan(0);
      writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, at) }));
      return () => {
        writeFileSync(journalPath, full);
      };
    }

    beforeEach(async () => {
      dir = tempDir('git-moxfield-migrations-');
      migrations = join(dir, 'drizzle');
      cpSync(MIGRATIONS, migrations, { recursive: true });
      url = `file:${join(dir, 'app.db')}`;

      const handle = await openFile(url);
      const repos = createRepositories(handle.db);
      const deck = await createTestDeck(repos);
      const v1 = await commitTestSnapshot(repos, deck, buildSnapshot(baseDeckSpec()));
      await commitTestSnapshot(repos, deck, buildSnapshot({ ...baseDeckSpec(), primer: '# Updated\n' }));
      await observeTestSnapshot(repos, deck, buildSnapshot({ ...baseDeckSpec(), primer: null }));
      await repos.tags.add(v1.id, 'tournament');
      await repos.notes.upsert(v1.id, 'note', { text: 'Top 4' });
      before = await rowCounts(handle.db);
      handle.close();
      for (const count of Object.values(before)) expect(count).toBeGreaterThan(0);
    });

    afterEach(() => {
      for (const handle of open.splice(0)) handle.close();
      rmSync(dir, { recursive: true, force: true });
    });

    async function reopen(): Promise<LibsqlExecutor> {
      return (await openFile(url)).db;
    }

    it('applies a drizzle-kit table rebuild without losing rows or the triggers', async () => {
      addMigration('9000_rebuild_snapshots', REBUILD_SNAPSHOTS);
      const db = await reopen();
      expect(await rowCounts(db)).toEqual(before);
      expect(await sqliteNames(db, 'trigger')).toEqual(IMMUTABILITY_TRIGGERS);
      expect(await sqliteNames(db, 'table')).not.toContain('__new_snapshots');
      expect(await pragma(db, 'foreign_keys')).toEqual([{ foreign_keys: 1 }]);
      await expectDatabaseError(
        db.run(sql`UPDATE snapshots SET canonical_json = '{}'`),
        'trigger',
        /snapshots are immutable/,
      );
    });

    it('rebuilds a parent table without cascading deletes into the history', async () => {
      addMigration('9000_rebuild_decks', REBUILD_DECKS);
      const db = await reopen();
      expect(await rowCounts(db)).toEqual(before);
      expect(await sqliteNames(db, 'trigger')).toEqual(IMMUTABILITY_TRIGGERS);
      expect(await pragma(db, 'foreign_key_check')).toEqual([]);
      await expectDatabaseError(db.run(sql`DELETE FROM commits`), 'trigger', /commits are immutable/);
    });

    it('refuses to open a database that a migration left with dangling references', async () => {
      addMigration('9000_dangling_reference', DANGLING_REFERENCE);
      await expect(reopen()).rejects.toThrow(/foreign key violation.*observations/);
    });

    it('makes the card catalog per workspace, copying each fact to the workspaces that show the card (0005)', async () => {
      // Back to the schema before 0005: a shared catalog keyed by card name only.
      const restoreJournal = journalBefore('0005_security_hardening');
      const fresh = `file:${join(dir, 'before-0005.db')}`;
      const old = await openFile(fresh);
      const repos = createRepositories(old.db);
      const alice = await repos.users.create({ displayName: 'Alice', role: 'member' });
      const bob = await repos.users.create({ displayName: 'Bob', role: 'member' });
      const alices = createRepositories(old.db, { workspaceId: alice.workspaceId });
      const bobs = createRepositories(old.db, { workspaceId: bob.workspaceId });
      const deck = (zones: string[]) => buildSnapshot({ ...baseDeckSpec(), zones: { mainboard: zones } });
      await commitTestSnapshot(alices, await createTestDeck(alices), deck(['Sol Ring', 'Island']));
      await observeTestSnapshot(bobs, await createTestDeck(bobs), deck(['Island', 'Mana Vault']));
      for (const [key, name] of [
        ['sol ring', 'Sol Ring'],
        ['island', 'Island'],
        ['mana vault', 'Mana Vault'],
        ['unused card', 'Unused Card'],
      ] as const) {
        await old.db.run(
          sql`INSERT INTO card_catalog (key, name, type_line, primary_type, mana_cost, cmc, color_identity_json, layout, scryfall_id, updated_at)
              VALUES (${key}, ${name}, 'Artifact', 'Artifact', '{1}', 1, '[]', 'normal', NULL, '2026-01-01T00:00:00.000Z')`,
        );
      }
      old.close();

      restoreJournal();
      const db = (await openFile(fresh)).db;
      const rows = await db.all(
        sql`SELECT workspace_id AS workspace, key FROM card_catalog ORDER BY workspace_id, key`,
      );
      expect(rows).toEqual(
        [
          { workspace: alice.workspaceId, key: 'island' },
          { workspace: alice.workspaceId, key: 'sol ring' },
          { workspace: bob.workspaceId, key: 'island' },
          { workspace: bob.workspaceId, key: 'mana vault' },
        ].sort((a, b) => a.workspace.localeCompare(b.workspace) || a.key.localeCompare(b.key)),
      );
      expect(await pragma(db, 'foreign_key_check')).toEqual([]);
      const columns = await pragma<{ name: string; dflt_value: string }>(db, 'table_info(sessions)');
      expect(columns.find((column) => column.name === 'pending_handoff')?.dflt_value).toBe('false');
    });

    it('records the key a share link descends from, keeping existing links (0006, 0007)', async () => {
      const restoreJournal = journalBefore('0006_share_links');
      const fresh = `file:${join(dir, 'before-0006.db')}`;
      const old = await openFile(fresh);
      const owner = await createRepositories(old.db).users.create({ displayName: 'Mikko', role: 'member' });
      const deck = await createTestDeck(createRepositories(old.db, { workspaceId: owner.workspaceId }));
      await old.db.run(
        sql`INSERT INTO share_links (id, deck_id, token_hash, label, include_notes, created_by_user_id, created_at)
            VALUES ('link-1', ${deck.id}, ${'a'.repeat(64)}, 'For Pekka', 1, ${owner.id}, '2026-10-01T00:00:00.000Z')`,
      );
      old.close();

      restoreJournal();
      const db = (await openFile(fresh)).db;
      const link = await createRepositories(db).shareLinks.findActive('a'.repeat(64));
      expect(link?.link).toMatchObject({
        id: 'link-1',
        label: 'For Pekka',
        includeNotes: true,
        credentialId: null,
      });
      const references = await pragma<{ table: string; from: string; on_delete: string }>(
        db,
        'foreign_key_list(share_links)',
      );
      expect(references.find((reference) => reference.from === 'credential_id')).toMatchObject({
        table: 'credentials',
        on_delete: 'SET NULL',
      });
      const indexes = (await pragma<{ name: string }>(db, 'index_list(share_links)')).map((i) => i.name);
      expect(indexes).toEqual(
        expect.arrayContaining([
          'share_links_credential_idx',
          'share_links_deck_idx',
          'share_links_token_hash_unique',
        ]),
      );
      expect(await sqliteNames(db, 'table')).not.toContain('__new_share_links');
      expect(await sqliteNames(db, 'trigger')).toEqual(IMMUTABILITY_TRIGGERS);
      expect(await pragma(db, 'foreign_key_check')).toEqual([]);
    });

    it('indexes the card index by card and snapshot, keeping its rows (0008)', async () => {
      const restoreJournal = journalBefore('0008_card_key_snapshot_index');
      const fresh = `file:${join(dir, 'before-0008.db')}`;
      const old = await openFile(fresh);
      const repos = createRepositories(old.db);
      const deck = await createTestDeck(repos);
      const v1 = await commitTestSnapshot(repos, deck, buildSnapshot(baseDeckSpec()));
      expect(await sqliteNames(old.db, 'index')).toContain('snapshot_cards_card_key_idx');
      const cards = await countRows(old.db, 'snapshot_cards');
      old.close();

      restoreJournal();
      const db = (await openFile(fresh)).db;
      const indexes = await sqliteNames(db, 'index');
      expect(indexes).toContain('snapshot_cards_card_key_snapshot_idx');
      expect(indexes).not.toContain('snapshot_cards_card_key_idx');
      const columns = await pragma<{ name: string }>(db, 'index_info(snapshot_cards_card_key_snapshot_idx)');
      expect(columns.map((column) => column.name)).toEqual(['card_key', 'snapshot_hash']);
      expect(await countRows(db, 'snapshot_cards')).toBe(cards);
      expect(await sqliteNames(db, 'trigger')).toEqual(IMMUTABILITY_TRIGGERS);
      const history = await createRepositories(db).cardIndex.versionsContainingCard(deck.id, 'Sol Ring');
      expect(history.map((version) => version.commitId)).toEqual([v1.id]);
    });

    it('adds the record of source deck changes to a database with history (0009)', async () => {
      const restoreJournal = journalBefore('0009_deck_relinks');
      const fresh = `file:${join(dir, 'before-0009.db')}`;
      const old = await openFile(fresh);
      const repos = createRepositories(old.db);
      const deck = await createTestDeck(repos, { externalId: 'OldDeckId' });
      const v1 = await commitTestSnapshot(repos, deck, buildSnapshot(baseDeckSpec()));
      expect(await sqliteNames(old.db, 'table')).not.toContain('deck_relinks');
      old.close();

      restoreJournal();
      const db = (await openFile(fresh)).db;
      expect(await sqliteNames(db, 'index')).toContain('deck_relinks_deck_idx');
      expect(await sqliteNames(db, 'trigger')).toEqual(IMMUTABILITY_TRIGGERS);
      const upgraded = createRepositories(db);
      await upgraded.decks.relink(deck.id, {
        expectedExternalId: 'OldDeckId',
        externalId: 'NewDeckId',
        url: 'https://moxfield.com/decks/NewDeckId',
      });
      expect((await upgraded.commits.lineage(deck.id)).map((commit) => commit.id)).toEqual([v1.id]);
      expect(await upgraded.decks.listRelinks(deck.id)).toHaveLength(1);
      expect(await pragma(db, 'foreign_key_check')).toEqual([]);
      // The record goes with its deck.
      expect(await upgraded.decks.delete(deck.id)).toBe(true);
      expect(await countRows(db, 'deck_relinks')).toBe(0);
    });

    it('opens an up-to-date database unchanged', async () => {
      const db = await reopen();
      expect(await rowCounts(db)).toEqual(before);
    });
  });
});
