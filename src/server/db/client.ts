/**
 * Database connection. Created lazily (never at import time, so `next build` has no
 * database side effects) and cached on `globalThis` so it survives dev-server HMR.
 */
import 'server-only';

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { getConfig } from '../config';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export const LOCAL_WORKSPACE_ID = 'local';

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

export interface OpenDatabaseOptions {
  /** Folder with the Drizzle migrations and their journal. Default: `drizzle/` in the working directory. */
  migrationsFolder?: string;
}

/**
 * Opens a database, applies migrations and seeds the local workspace. The connection
 * enforces foreign keys. Pass `':memory:'` for an isolated in-memory database (tests).
 *
 * @throws when a migration fails (it is rolled back) or leaves dangling references.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Db {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const sqlite = new Database(path);
  try {
    sqlite.pragma('busy_timeout = 5000');
    if (path !== ':memory:') sqlite.pragma('journal_mode = WAL');
    const db: Db = drizzle(sqlite, { schema });
    migrateDatabase(db, options.migrationsFolder ?? MIGRATIONS_FOLDER);
    db.insert(schema.workspaces)
      .values({ id: LOCAL_WORKSPACE_ID, name: 'Local', createdAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
    return db;
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

/** A row of `PRAGMA foreign_key_check`. */
interface ForeignKeyViolation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

/**
 * Applies the pending migrations with foreign key enforcement off, verifies referential
 * integrity, then turns enforcement on for the connection.
 *
 * Drizzle applies all pending migrations inside one `BEGIN…COMMIT`, where
 * `PRAGMA foreign_keys` is a no-op, so the `PRAGMA foreign_keys=OFF` that drizzle-kit
 * writes around a table rebuild (`CREATE __new_x` / `INSERT…SELECT` / `DROP x` /
 * `RENAME`) has no effect there. With enforcement on, the implicit `DELETE` of
 * `DROP TABLE` fails on `NO ACTION` references, or silently cascades child rows (commits,
 * branches, tags, notes) away. Here no transaction is open, so the pragma takes effect.
 */
function migrateDatabase(db: Db, migrationsFolder: string): void {
  const sqlite = db.$client;
  sqlite.pragma('foreign_keys = OFF');
  migrate(db, { migrationsFolder });
  const violations = sqlite.pragma('foreign_key_check') as ForeignKeyViolation[];
  if (violations.length > 0) {
    const tables = [...new Set(violations.map((violation) => violation.table))].sort().join(', ');
    throw new Error(
      `The database has ${violations.length} foreign key violation${violations.length === 1 ? '' : 's'} ` +
        `after migrating (in ${tables}). Restore a backup made before the upgrade, or fix the rows ` +
        'that PRAGMA foreign_key_check lists.',
    );
  }
  sqlite.pragma('foreign_keys = ON');
}

const globalForDb = globalThis as unknown as { __gitMoxfieldDb?: Db };

export function getDb(): Db {
  globalForDb.__gitMoxfieldDb ??= openDatabase(getConfig().DATABASE_PATH);
  return globalForDb.__gitMoxfieldDb;
}
