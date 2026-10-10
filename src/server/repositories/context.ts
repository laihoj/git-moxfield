/**
 * Shared plumbing for repositories: the query executor type, the injected clock and
 * id generator, transactions and batching helpers. Internal to `src/server/repositories`.
 */
import type { RunResult } from 'better-sqlite3';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

import type * as schema from '@/server/db/schema';

import { RepositoryError } from './errors';

/**
 * Anything that can run queries against the git-moxfield schema: the root database
 * ({@link import('@/server/db/client').Db}) or an open transaction. All queries are
 * synchronous (better-sqlite3).
 */
export type DbExecutor = BaseSQLiteDatabase<'sync', RunResult, typeof schema>;

export interface RepositoryContext {
  readonly db: DbExecutor;
  /** Workspace that deck queries are scoped to (`local` today). */
  readonly workspaceId: string;
  /** Current time as an ISO-8601 UTC timestamp with milliseconds. */
  readonly now: () => string;
  /** A fresh random id for rows without a content-derived key. */
  readonly newId: () => string;
}

/**
 * Runs `fn` atomically. At the top level this opens an `IMMEDIATE` transaction (the
 * write lock is taken up front, so read-check-write sequences cannot interleave with
 * other connections); inside an existing transaction it uses a savepoint. Throwing
 * from `fn` rolls back everything `fn` did. `fn` must be synchronous.
 */
export function withTransaction<T>(ctx: RepositoryContext, fn: (tx: RepositoryContext) => T): T {
  return ctx.db.transaction((tx) => fn({ ...ctx, db: tx }), { behavior: 'immediate' });
}

/**
 * Runs a write whose only failure mode for valid input is a dangling reference, and
 * reports a violated foreign key as a `not-found` {@link RepositoryError}.
 */
export function referencing<T>(what: string, write: () => T): T {
  try {
    return write();
  } catch (error) {
    if (isSqliteErrorCode(error, 'SQLITE_CONSTRAINT_FOREIGNKEY')) {
      throw new RepositoryError('not-found', `${what} references a row that does not exist`, {
        cause: error,
      });
    }
    throw error;
  }
}

function isSqliteErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/**
 * Maximum rows per multi-row statement / values per `IN (...)` list. Well below
 * SQLite's bound-parameter limit even for the widest table.
 */
export const BATCH_SIZE = 500;

/** Splits a list into consecutive batches of at most `size` items. */
export function batches<T>(items: readonly T[], size = BATCH_SIZE): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

/** Distinct values in first-seen order. */
export function distinct<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}
