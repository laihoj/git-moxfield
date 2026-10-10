/**
 * Schema migration state: whether a database has exactly the migrations this build ships
 * ({@link checkMigrationState}, cheap enough for every cold start), and applying them
 * ({@link applyMigrations}, for the deploy step and scripts only).
 *
 * Migrations never run on the request path: concurrent cold starts would race (the losers
 * fail with "table ... already exists"), and the integrity check after migrating reads
 * every row of every table with a foreign key. At runtime the app only checks the state
 * and fails clearly when it is not `up-to-date`.
 *
 * The state compares the rows of Drizzle's `__drizzle_migrations` table (`created_at` =
 * the journal entry's `when`) with `drizzle/meta/_journal.json`, which is imported
 * statically so that bundlers include it in the serverless function. The migration SQL
 * files are only read by {@link applyMigrations}.
 */
import 'server-only';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';

import bundledJournal from '../../../drizzle/meta/_journal.json';
import type { LibsqlDb, LibsqlExecutor } from './libsql';
import { runWrite } from './transaction';

/** Table in which Drizzle records applied migrations. */
export const MIGRATIONS_TABLE = '__drizzle_migrations';

/** Default folder with the migration SQL files and `meta/_journal.json`. */
export const DEFAULT_MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

/** One migration of a Drizzle journal. */
export interface MigrationJournalEntry {
  /** File name without `.sql`, e.g. `0001_immutability_triggers`. */
  readonly tag: string;
  /** Creation time in ms; recorded as `created_at` once applied. */
  readonly when: number;
}

export type MigrationStatus =
  /** Every migration of the journal is applied, and nothing else. */
  | 'up-to-date'
  /** Some migrations of the journal are not applied yet (`pending`). */
  | 'behind'
  /**
   * The database records migrations this journal does not have: a newer (or a different)
   * build migrated it. Never migrate it with this build.
   */
  | 'ahead'
  /** No migration was ever applied (no migrations table, or an empty one). */
  | 'missing';

export interface MigrationState {
  readonly status: MigrationStatus;
  /** Migrations recorded in the database. */
  readonly applied: number;
  /** Migrations in the journal. */
  readonly expected: number;
  /** Tags of the journal's migrations that are not applied, oldest first. */
  readonly pending: readonly string[];
  /** Recorded migrations that the journal does not know. */
  readonly unknown: number;
}

/** The database is not in the migration state the caller needs. */
export class MigrationStateError extends Error {
  override readonly name = 'MigrationStateError';
  readonly state: MigrationState;

  constructor(state: MigrationState, message = describeMigrationState(state)) {
    super(message);
    this.state = state;
  }
}

function isJournalEntry(value: unknown): value is MigrationJournalEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tag' in value &&
    typeof value.tag === 'string' &&
    'when' in value &&
    typeof value.when === 'number' &&
    Number.isSafeInteger(value.when)
  );
}

/** The entries of a parsed `_journal.json`, oldest first. */
export function parseMigrationJournal(journal: unknown, source: string): readonly MigrationJournalEntry[] {
  const entries =
    typeof journal === 'object' && journal !== null && 'entries' in journal ? journal.entries : undefined;
  if (!Array.isArray(entries) || !entries.every(isJournalEntry)) {
    throw new Error(`${source} is not a Drizzle migration journal`);
  }
  return Object.freeze(entries.map(({ tag, when }) => Object.freeze({ tag, when })));
}

let bundled: readonly MigrationJournalEntry[] | undefined;

/** The migrations this build ships (`drizzle/meta/_journal.json`), oldest first. */
export function bundledMigrations(): readonly MigrationJournalEntry[] {
  bundled ??= parseMigrationJournal(bundledJournal, 'drizzle/meta/_journal.json');
  return bundled;
}

/** Reads the journal of a migrations folder (scripts only: needs the file system). */
export function readMigrationJournal(migrationsFolder: string): readonly MigrationJournalEntry[] {
  const path = join(migrationsFolder, 'meta', '_journal.json');
  return parseMigrationJournal(JSON.parse(readFileSync(path, 'utf8')) as unknown, path);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** A one-line, user-facing explanation of `state`. */
export function describeMigrationState(state: MigrationState): string {
  switch (state.status) {
    case 'up-to-date':
      return `The database is up to date (${plural(state.expected, 'migration')} applied).`;
    case 'missing':
      return 'The database has not been migrated yet. Run `pnpm db:migrate` against it.';
    case 'behind':
      return (
        `The database is ${plural(state.pending.length, 'migration')} behind ` +
        `(${state.pending.join(', ')}). Run \`pnpm db:migrate\` against it.`
      );
    case 'ahead':
      return (
        `The database was migrated by a newer version of git-moxfield ` +
        `(${plural(state.unknown, 'unknown migration')}` +
        (state.pending.length > 0 ? `; not applied: ${state.pending.join(', ')}` : '') +
        '). Upgrade git-moxfield or restore a backup made with this version.'
      );
  }
}

/**
 * Compares the migrations recorded in the database with `journal` (default: the ones this
 * build ships). Reads the schema catalog and the migrations table, nothing else.
 */
export async function checkMigrationState(
  db: LibsqlExecutor,
  journal: readonly MigrationJournalEntry[] = bundledMigrations(),
): Promise<MigrationState> {
  // `db.all`, not `db.get`: drizzle's libSQL driver throws on a raw `get` without rows.
  const tables = await db.all<{ found: number }>(
    sql`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ${MIGRATIONS_TABLE}`,
  );
  const rows =
    tables.length === 0
      ? []
      : await db.all<{ createdAt: number | string | null }>(
          sql`SELECT created_at AS createdAt FROM ${sql.identifier(MIGRATIONS_TABLE)}`,
        );
  const recorded = new Set(rows.map((row) => Number(row.createdAt)));
  const known = new Set(journal.map((entry) => entry.when));
  const pending = journal.filter((entry) => !recorded.has(entry.when)).map((entry) => entry.tag);
  const unknown = [...recorded].filter((when) => !known.has(when)).length;
  const status: MigrationStatus =
    rows.length === 0 ? 'missing' : unknown > 0 ? 'ahead' : pending.length > 0 ? 'behind' : 'up-to-date';
  return { status, applied: rows.length, expected: journal.length, pending, unknown };
}

/**
 * Resolves when the database has exactly the migrations this build ships.
 *
 * @throws {MigrationStateError} otherwise, with a message that says what to do.
 */
export async function assertMigrationsUpToDate(db: LibsqlExecutor): Promise<MigrationState> {
  const state = await checkMigrationState(db);
  if (state.status !== 'up-to-date') throw new MigrationStateError(state);
  return state;
}

/**
 * The app's runtime check of a remote database (migrated by the deploy, never by the app):
 * resolves when every migration of `journal` (default: the ones this build ships) is
 * applied, with the state. That is `up-to-date`, or `ahead` with nothing pending: a newer
 * build added migrations, which are backward compatible with the deploy that was live when
 * they were applied (ADR 0008: expand, then contract). The caller should log an `ahead`
 * state.
 *
 * Tolerating `ahead` keeps the live deploy working while a new deploy is published (its
 * migrations run before the publish, and stay applied if the publish fails), and after an
 * instant rollback to an earlier deploy. Never migrate an `ahead` database with this build
 * ({@link applyMigrations} refuses).
 *
 * @throws {MigrationStateError} when a migration of `journal` is not applied (the database
 *   is `missing`, `behind`, or `ahead` along another line of migrations), with a message
 *   that says what to do.
 */
export async function assertMigrationsApplied(
  db: LibsqlExecutor,
  journal: readonly MigrationJournalEntry[] = bundledMigrations(),
): Promise<MigrationState> {
  const state = await checkMigrationState(db, journal);
  const servable = state.status === 'up-to-date' || (state.status === 'ahead' && state.pending.length === 0);
  if (!servable) throw new MigrationStateError(state);
  return state;
}

/** A row of `PRAGMA foreign_key_check`. */
interface ForeignKeyViolation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

async function assertNoForeignKeyViolations(db: LibsqlDb): Promise<void> {
  const violations = await db.all<ForeignKeyViolation>(sql`PRAGMA foreign_key_check`);
  if (violations.length === 0) return;
  const tables = [...new Set(violations.map((violation) => violation.table))].sort().join(', ');
  throw new Error(
    `The database has ${plural(violations.length, 'foreign key violation')} after migrating ` +
      `(in ${tables}). Restore a backup made before the upgrade, or fix the rows that ` +
      'PRAGMA foreign_key_check lists.',
  );
}

export interface ApplyMigrationsOptions {
  /** Folder with the SQL files and `meta/_journal.json`. Default: `drizzle/` in the working directory. */
  migrationsFolder?: string;
}

export interface ApplyMigrationsResult {
  /** Tags of the migrations this call applied, oldest first (empty when up to date). */
  readonly applied: readonly string[];
  /** The state afterwards (always `up-to-date`). */
  readonly state: MigrationState;
}

/**
 * Applies the pending migrations of `migrationsFolder` in one atomic batch, then (only if
 * something was applied) verifies referential integrity with `PRAGMA foreign_key_check`.
 *
 * The batch runs with foreign keys off (libSQL's `client.migrate()`), so the table
 * rebuilds drizzle-kit writes (`CREATE __new_x` / `INSERT ... SELECT` / `DROP x` /
 * `RENAME`) neither fail on nor cascade into referencing rows; the `PRAGMA
 * foreign_keys=OFF/ON` lines inside migration files are no-ops there. Holds the database's
 * write lock; never retried. Not safe to run from two processes at once (the loser fails
 * with "table ... already exists" and changes nothing); run it from one deploy step.
 *
 * @throws {MigrationStateError} when the database is `ahead` (nothing is applied) or still
 *   not up to date afterwards (a migration older than the newest applied one is never
 *   applied by Drizzle).
 * @throws {Error} when the migrated data violates foreign keys (the migrations stay
 *   applied; restore the backup made before the upgrade).
 */
export async function applyMigrations(
  db: LibsqlDb,
  options: ApplyMigrationsOptions = {},
): Promise<ApplyMigrationsResult> {
  const migrationsFolder = options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;
  const journal = readMigrationJournal(migrationsFolder);
  return runWrite(
    db,
    async () => {
      const before = await checkMigrationState(db, journal);
      if (before.status === 'ahead') throw new MigrationStateError(before);
      if (before.status === 'up-to-date') return { applied: [], state: before };

      await migrate(db, { migrationsFolder });
      const after = await checkMigrationState(db, journal);
      const applied = before.pending.filter((tag) => !after.pending.includes(tag));
      if (applied.length > 0) await assertNoForeignKeyViolations(db);
      if (after.status !== 'up-to-date') {
        throw new MigrationStateError(
          after,
          `${describeMigrationState(after)} Drizzle skips migrations older than the newest ` +
            'applied one; give the pending migrations a later timestamp in the journal.',
        );
      }
      return { applied, state: after };
    },
    { retries: 0 },
  );
}
