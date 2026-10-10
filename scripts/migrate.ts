/**
 * Applies the database migrations in `drizzle/` to `DATABASE_PATH`
 * (default `data/git-moxfield.db`; read from the environment and `.env*` files like the
 * app does) and reports what was applied.
 *
 *   pnpm db:migrate
 *
 * The app migrates on first use as well (`openDatabase`); this script makes the step
 * explicit for deployments, backups and troubleshooting. Exits with code 1 and a
 * message when migrating fails or the database was migrated by a newer git-moxfield.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { getConfig } from '@/server/config';
import { openDatabase } from '@/server/db/client';

import { loadEnvFiles } from './load-env';

/** Table in which Drizzle records applied migrations (`created_at` = the journal's `when`). */
const MIGRATIONS_TABLE = '__drizzle_migrations';

interface JournalEntry {
  tag: string;
  when: number;
}

function isJournalEntry(value: unknown): value is JournalEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tag' in value &&
    typeof value.tag === 'string' &&
    'when' in value &&
    typeof value.when === 'number'
  );
}

/** The migrations shipped with this build, oldest first. */
function readJournal(): JournalEntry[] {
  const path = join(process.cwd(), 'drizzle', 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const entries =
    typeof journal === 'object' && journal !== null && 'entries' in journal ? journal.entries : undefined;
  if (!Array.isArray(entries) || !entries.every(isJournalEntry)) {
    throw new Error(`${path} is not a Drizzle migration journal`);
  }
  return entries;
}

/** Timestamps of the migrations recorded in a database (empty for a new database). */
function appliedMigrations(sqlite: Database.Database): Set<number> {
  const table = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
  if (table === undefined) return new Set();
  const rows = sqlite.prepare(`SELECT created_at AS createdAt FROM "${MIGRATIONS_TABLE}"`).all() as {
    createdAt: number | string;
  }[];
  return new Set(rows.map((row) => Number(row.createdAt)));
}

function appliedBefore(path: string): Set<number> {
  if (path === ':memory:' || !existsSync(path)) return new Set();
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return appliedMigrations(sqlite);
  } finally {
    sqlite.close();
  }
}

function migrate(path: string): number {
  const journal = readJournal();
  const created = path !== ':memory:' && !existsSync(path);
  const before = appliedBefore(path);
  const db = openDatabase(path);
  let after: Set<number>;
  try {
    after = appliedMigrations(db.$client);
  } finally {
    db.$client.close();
  }

  const known = new Set(journal.map((entry) => entry.when));
  const unknown = [...after].filter((when) => !known.has(when));
  const pending = journal.filter((entry) => !after.has(entry.when));
  const applied = journal.filter((entry) => after.has(entry.when) && !before.has(entry.when));

  const shown = path === ':memory:' ? path : resolve(path);
  // A new file usually means DATABASE_PATH does not point at the app's database.
  console.log(created ? `Created a new database: ${shown}` : `Database: ${shown}`);
  if (applied.length > 0) {
    console.log(`Applied ${applied.length} migration${applied.length === 1 ? '' : 's'}:`);
    for (const entry of applied) console.log(`  ${entry.tag}`);
  }
  if (unknown.length > 0 || pending.length > 0) {
    console.error(
      'The database was migrated by a newer version of git-moxfield ' +
        `(${unknown.length} unknown migration${unknown.length === 1 ? '' : 's'}` +
        (pending.length > 0 ? `; not applied: ${pending.map((entry) => entry.tag).join(', ')}` : '') +
        '). Upgrade git-moxfield or restore a backup made with this version.',
    );
    return 1;
  }
  console.log(
    applied.length > 0
      ? `Up to date: all ${journal.length} migrations applied.`
      : `Already up to date (${journal.length} migrations applied).`,
  );
  return 0;
}

function main(): number {
  let path: string;
  try {
    loadEnvFiles();
    path = getConfig().DATABASE_PATH;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  try {
    return migrate(path);
  } catch (error) {
    console.error(`Migrating ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

process.exitCode = main();
