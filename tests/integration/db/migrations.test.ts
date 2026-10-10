/**
 * Schema migrations on populated databases. In-memory test databases are always
 * migrated empty, which hides migrations that fail or lose data on existing installs,
 * so these tests upgrade a file database that holds a deck with history.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '@/server/db/client';
import { createRepositories } from '@/server/repositories';
import { baseDeckSpec, buildSnapshot } from '@tests/support/builders';
import {
  commitTestSnapshot,
  countRows,
  createTestDeck,
  observeTestSnapshot,
  openTestDatabase,
} from '@tests/support/db';

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

function sqliteNames(db: Db, type: 'table' | 'trigger'): string[] {
  const rows = db.$client
    .prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name')
    .all(type) as { name: string }[];
  return rows.map((row) => row.name);
}

function rowCounts(db: Db): Record<string, number> {
  return Object.fromEntries(HISTORY_TABLES.map((table) => [table, countRows(db, table)]));
}

describe('database migrations', () => {
  it('enforces foreign keys and installs the immutability triggers', () => {
    const db = openTestDatabase();
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(sqliteNames(db, 'trigger')).toEqual(IMMUTABILITY_TRIGGERS);
  });

  describe('upgrading a database that holds history', () => {
    let dir: string;
    let migrations: string;
    let path: string;
    let before: Record<string, number>;

    /** Adds a migration after the shipped ones to the copied migrations folder. */
    function addMigration(tag: string, sql: string): void {
      const journalPath = join(migrations, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
      };
      const last = journal.entries.at(-1);
      if (!last) throw new Error('The migration journal is empty');
      journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag });
      writeFileSync(journalPath, JSON.stringify(journal, null, 2));
      writeFileSync(join(migrations, `${tag}.sql`), sql);
    }

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'git-moxfield-migrations-'));
      migrations = join(dir, 'drizzle');
      cpSync(MIGRATIONS, migrations, { recursive: true });
      path = join(dir, 'app.db');

      const db = openDatabase(path);
      const repos = createRepositories(db);
      const deck = createTestDeck(repos);
      const v1 = commitTestSnapshot(repos, deck, buildSnapshot(baseDeckSpec()));
      commitTestSnapshot(repos, deck, buildSnapshot({ ...baseDeckSpec(), primer: '# Updated\n' }));
      observeTestSnapshot(repos, deck, buildSnapshot({ ...baseDeckSpec(), primer: null }));
      repos.tags.add(v1.id, 'tournament');
      repos.notes.upsert(v1.id, 'note', { text: 'Top 4' });
      before = rowCounts(db);
      db.$client.close();
      for (const count of Object.values(before)) expect(count).toBeGreaterThan(0);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function reopen(): Db {
      return openDatabase(path, { migrationsFolder: migrations });
    }

    it('applies a drizzle-kit table rebuild without losing rows or the triggers', () => {
      addMigration('9000_rebuild_snapshots', REBUILD_SNAPSHOTS);
      const db = reopen();
      try {
        expect(rowCounts(db)).toEqual(before);
        expect(sqliteNames(db, 'trigger')).toEqual(IMMUTABILITY_TRIGGERS);
        expect(sqliteNames(db, 'table')).not.toContain('__new_snapshots');
        expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
        expect(() => db.$client.prepare("UPDATE snapshots SET canonical_json = '{}'").run()).toThrow(
          'snapshots are immutable',
        );
      } finally {
        db.$client.close();
      }
    });

    it('rebuilds a parent table without cascading deletes into the history', () => {
      addMigration('9000_rebuild_decks', REBUILD_DECKS);
      const db = reopen();
      try {
        expect(rowCounts(db)).toEqual(before);
        expect(sqliteNames(db, 'trigger')).toEqual(IMMUTABILITY_TRIGGERS);
        expect(db.$client.pragma('foreign_key_check')).toEqual([]);
        expect(() => db.$client.prepare('DELETE FROM commits').run()).toThrow('commits are immutable');
      } finally {
        db.$client.close();
      }
    });

    it('refuses to open a database that a migration left with dangling references', () => {
      addMigration('9000_dangling_reference', DANGLING_REFERENCE);
      expect(reopen).toThrow(/foreign key violation.*observations/);
    });

    it('opens an up-to-date database unchanged', () => {
      const db = reopen();
      try {
        expect(rowCounts(db)).toEqual(before);
      } finally {
        db.$client.close();
      }
    });
  });
});
