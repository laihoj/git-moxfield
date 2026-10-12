/**
 * Opening the source database of an import without ever touching it: SQLite writes even
 * when it only reads (it creates `-wal`/`-shm` files, checkpoints the write-ahead log and,
 * here, would be migrated to this build's schema). So the file is copied into a private
 * temporary directory, with its write-ahead log, and only the copy is opened.
 */
import 'server-only';

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { sql } from 'drizzle-orm';

import { createLibsqlDatabase, type LibsqlDatabase } from '@/server/db/libsql';
import { applyMigrations, MIGRATIONS_TABLE, MigrationStateError } from '@/server/db/migration-state';
import { classifySqlError } from '@/server/db/sql-errors';

import { HistoryImportError } from './errors';

/** Files that belong to a SQLite database besides the main file (the `-shm` index is rebuilt). */
const COMPANION_SUFFIXES = ['-wal', '-journal'] as const;

/** How often the copy is retried when the source changed while it was copied. */
const COPY_ATTEMPTS = 3;

/** An opened copy of a source database; {@link SourceCopy.dispose} closes and deletes it. */
export interface SourceCopy {
  readonly database: LibsqlDatabase;
  /** The copied main file (inside a private temporary directory). */
  readonly path: string;
  /** Migrations this build applied to the copy (the source predates them). */
  readonly migrated: readonly string[];
  /** Closes the copy and deletes it. Idempotent. */
  dispose(): void;
}

function fingerprint(path: string): string {
  return ['', ...COMPANION_SUFFIXES]
    .map((suffix) => {
      const file = `${path}${suffix}`;
      if (!existsSync(file)) return `${suffix}:none`;
      const stats = statSync(file);
      return `${suffix}:${stats.size}:${stats.mtimeMs}`;
    })
    .join('|');
}

/**
 * Copies the database at `sourcePath` (and its `-wal`/`-journal` file) into `dir`. A copy
 * taken while another process writes could be torn, so the files are fingerprinted before
 * and after copying, and the copy is taken again when they changed.
 *
 * @returns the path of the copied main file.
 * @throws {HistoryImportError} when the source is missing, not a file, or keeps changing.
 */
export function copyDatabaseFiles(sourcePath: string, dir: string): string {
  if (!existsSync(sourcePath)) throw new HistoryImportError(`There is no file at ${sourcePath}.`);
  if (!statSync(sourcePath).isFile()) throw new HistoryImportError(`${sourcePath} is not a file.`);
  const target = join(dir, basename(sourcePath));
  for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt++) {
    const before = fingerprint(sourcePath);
    copyFileSync(sourcePath, target);
    for (const suffix of COMPANION_SUFFIXES) {
      rmSync(`${target}${suffix}`, { force: true });
      if (existsSync(`${sourcePath}${suffix}`)) copyFileSync(`${sourcePath}${suffix}`, `${target}${suffix}`);
    }
    if (fingerprint(sourcePath) === before) return target;
  }
  throw new HistoryImportError(
    `${sourcePath} kept changing while it was copied. Stop the git-moxfield that uses it (or any script ` +
      'writing to it) and try again.',
  );
}

/** Table names of the database. */
async function tableNames(database: LibsqlDatabase): Promise<Set<string>> {
  const rows = await database.db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table'`,
  );
  return new Set(rows.map((row) => row.name));
}

/**
 * Copies the git-moxfield database at `sourcePath` to a private temporary directory, opens
 * the copy, checks it (SQLite integrity, a git-moxfield database at all) and migrates it to
 * this build's schema, so a database from any earlier version reads like a current one.
 * The source file itself is only ever read by the copy.
 *
 * @throws {HistoryImportError} for a missing, damaged or foreign file, or a database a
 *   newer git-moxfield wrote.
 */
export async function openSourceCopy(sourcePath: string): Promise<SourceCopy> {
  const dir = mkdtempSync(join(tmpdir(), 'git-moxfield-import-'));
  let database: LibsqlDatabase | undefined;
  const dispose = (): void => {
    database?.close();
    database = undefined;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const path = copyDatabaseFiles(sourcePath, dir);
    try {
      // No busy wait: nothing else knows about the copy.
      database = await createLibsqlDatabase({ url: pathToFileURL(path).href, busyTimeoutMs: 0 });
    } catch (error) {
      throw new HistoryImportError(
        `${sourcePath} cannot be opened as a SQLite database: ${classifySqlError(error).message}`,
        { cause: error },
      );
    }
    const opened = database;
    const check = await opened.db.all<{ quick_check: string }>(sql`PRAGMA quick_check`);
    if (check.length !== 1 || check[0]?.quick_check !== 'ok') {
      throw new HistoryImportError(
        `${sourcePath} is damaged (PRAGMA quick_check: ${check.map((row) => row.quick_check).join('; ')}). ` +
          'Import from a backup instead.',
      );
    }
    const tables = await tableNames(opened);
    if (!tables.has('decks') || !tables.has(MIGRATIONS_TABLE)) {
      throw new HistoryImportError(`${sourcePath} is not a git-moxfield database.`);
    }
    let migrated: readonly string[];
    try {
      ({ applied: migrated } = await applyMigrations(opened.db));
    } catch (error) {
      if (error instanceof MigrationStateError && error.state.status === 'ahead') {
        throw new HistoryImportError(
          `${sourcePath} was written by a newer git-moxfield than this one. Update this checkout and try again.`,
          { cause: error },
        );
      }
      throw new HistoryImportError(
        `${sourcePath} could not be brought up to this git-moxfield's schema: ${classifySqlError(error).message}`,
        { cause: error },
      );
    }
    return { database: opened, path, migrated, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
