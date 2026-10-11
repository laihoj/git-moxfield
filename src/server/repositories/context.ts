/**
 * Shared plumbing for repositories: the query executor type, the injected clock and
 * id generator, transactions, writes and batching helpers. Internal to
 * `src/server/repositories`.
 *
 * Every query is asynchronous (libSQL). Remotely each statement is an HTTP round trip, so
 * the helpers here keep writes to as few round trips as their guarantees allow:
 * {@link withTransaction} for read-check-write units, {@link writeAll} for write sets that
 * need no reads in between (one `db.batch()`), {@link write} for a single statement.
 */
import { and, eq, exists, inArray, sql, type SQL } from 'drizzle-orm';
import type { BatchItem, BatchResponse } from 'drizzle-orm/batch';
import { alias, type SQLiteColumn } from 'drizzle-orm/sqlite-core';

import type { LibsqlDb, LibsqlExecutor } from '@/server/db/libsql';
import * as schema from '@/server/db/schema';
import { classifySqlError } from '@/server/db/sql-errors';
import { isTransaction, runInTransaction, runWrite, type TransactionOptions } from '@/server/db/transaction';

import { RepositoryError } from './errors';

/**
 * Anything that can run queries against the git-moxfield schema: the root database
 * (`LibsqlDb`, see `@/server/db/client`) or a transaction (`tx` of `runInTransaction`).
 */
export type { LibsqlExecutor } from '@/server/db/libsql';

export interface RepositoryContext {
  /** The root database, or the transaction the repositories are bound to. */
  readonly db: LibsqlExecutor;
  /**
   * Workspace that every deck-reachable query is scoped to (see {@link inWorkspace}).
   * Account tables (users, credentials, sessions, links, invites) are installation-wide
   * and ignore it.
   */
  readonly workspaceId: string;
  /** Current time as an ISO-8601 UTC timestamp with milliseconds. */
  readonly now: () => string;
  /** A fresh random id for rows without a content-derived key. */
  readonly newId: () => string;
}

/**
 * Runs `fn` atomically and returns its result. With the root database this opens a
 * `BEGIN IMMEDIATE` transaction (the write lock is taken up front, so read-check-write
 * sequences cannot interleave with other writers) and may run `fn` again after a
 * transient failure; inside an existing transaction it uses a savepoint. Throwing from
 * `fn` rolls back everything `fn` did.
 *
 * `fn` must use the context it receives (never the outer one), must not do network I/O,
 * and may run more than once (see `runInTransaction`).
 */
export function withTransaction<T>(
  ctx: RepositoryContext,
  fn: (tx: RepositoryContext) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  return runInTransaction(ctx.db, (tx) => fn({ ...ctx, db: tx }), options);
}

/** The root database behind an executor that is not a transaction. */
function rootDatabase(db: LibsqlExecutor): LibsqlDb {
  // Every executor that is not a transaction is a root database opened by
  // `createLibsqlDatabase` (runWrite verifies that and fails clearly otherwise).
  return db as LibsqlDb;
}

/**
 * Runs a write that is atomic on its own (one statement, or several that may each run
 * again): on the root database under the database's write lock with `runWrite` (retried
 * after a transient failure, so `fn` must be safe to run twice), inside a transaction
 * directly on it.
 */
export function write<T>(ctx: RepositoryContext, fn: (db: LibsqlExecutor) => Promise<T>): Promise<T> {
  if (isTransaction(ctx.db)) return fn(ctx.db);
  return runWrite(rootDatabase(ctx.db), fn);
}

/** A statement for {@link writeAll}: a Drizzle query builder (it runs when awaited or batched). */
export type WriteStatement = BatchItem<'sqlite'> & PromiseLike<unknown>;

/** A non-empty list of statements for {@link writeAll}. */
export type WriteSet = readonly [WriteStatement, ...WriteStatement[]];

/**
 * Runs the statements `build` returns as one atomic unit, in order, and returns their
 * results (as `db.batch()` does): with the root database as a single `db.batch()` (one
 * round trip remotely, all or nothing, retried after a transient failure); inside a
 * transaction one by one on it, in a savepoint when there is more than one, so that a
 * failing statement undoes the earlier ones as a batch would.
 *
 * For write sets that need no reads in between. `build` may be called more than once and
 * must build its statements on the executor it receives.
 */
export async function writeAll<T extends WriteSet>(
  ctx: RepositoryContext,
  build: (db: LibsqlExecutor) => T,
): Promise<BatchResponse<T>> {
  if (!isTransaction(ctx.db)) {
    return runWrite(rootDatabase(ctx.db), (db) => db.batch(build(db)));
  }
  const statements = build(ctx.db);
  const runAll = async (): Promise<BatchResponse<T>> => {
    const results: unknown[] = [];
    // One at a time, in order (a builder runs when awaited).
    for (const statement of statements) results.push(await statement);
    return results as BatchResponse<T>;
  };
  // A single statement is atomic by itself; several need a savepoint to be. The savepoint
  // runs on the same transaction the statements were built on.
  return statements.length === 1 ? runAll() : runInTransaction(ctx.db, runAll);
}

/**
 * Workspace scoping. Every repository query that reaches deck data through a
 * caller-supplied id (deck, branch, commit, observation) is restricted to decks of the
 * context's workspace, so an id that belongs to another workspace behaves exactly like an
 * id that does not exist: reads return nothing, writes fail with `not-found`.
 * Content-addressed stores (snapshots, raw blobs) are shared by all workspaces and are only
 * reachable through hashes that these scoped queries return; their content is derived from
 * its own hash, so no workspace can change what another reads. The card catalog is keyed
 * by card name, not content, so it is scoped to the workspace like deck data.
 *
 * Turso bills every row a query reads, so the form of the restriction follows the query:
 *
 * - {@link deckInWorkspace} for one deck or one row: a probe of the owning deck by its
 *   primary key, one row read.
 * - {@link commitInWorkspace} for rows that hang off one commit (tags, notes): two rows.
 * - {@link inWorkspace} only for queries over the whole workspace: it reads every deck of
 *   the workspace, so it would make every per-deck query cost as many rows as the
 *   workspace has decks (and a deck list cost decks × decks).
 */
export function inWorkspace(
  ctx: Pick<RepositoryContext, 'db' | 'workspaceId'>,
  deckIdColumn: SQLiteColumn,
): SQL {
  return inArray(
    deckIdColumn,
    ctx.db
      .select({ id: schema.decks.id })
      .from(schema.decks)
      .where(eq(schema.decks.workspaceId, ctx.workspaceId)),
  );
}

/**
 * Restricts a query to rows of decks of the context's workspace (see {@link inWorkspace}
 * for the rules): `EXISTS (SELECT 1 FROM decks AS owner_deck WHERE owner_deck.id = <deck>
 * AND owner_deck.workspace_id = ?)`.
 *
 * - `deck` a deck id (a query about one deck): the subquery does not depend on the row,
 *   so SQLite runs it once per statement, one row read.
 * - `deck` a column (a lookup by a row's own id): it runs once per candidate row, a
 *   primary-key probe each.
 */
export function deckInWorkspace(
  ctx: Pick<RepositoryContext, 'db' | 'workspaceId'>,
  deck: string | SQLiteColumn,
): SQL {
  const owner = alias(schema.decks, 'owner_deck');
  return exists(
    ctx.db
      .select({ one: sql`1` })
      .from(owner)
      .where(and(eq(owner.id, deck), eq(owner.workspaceId, ctx.workspaceId))),
  );
}

/**
 * Restricts a query to rows of commits of decks of the context's workspace, like
 * {@link deckInWorkspace} (`commit` a commit id or a column): two rows read per probe.
 */
export function commitInWorkspace(
  ctx: Pick<RepositoryContext, 'db' | 'workspaceId'>,
  commit: string | SQLiteColumn,
): SQL {
  const ownerCommit = alias(schema.commits, 'owner_commit');
  const ownerDeck = alias(schema.decks, 'owner_deck');
  return exists(
    ctx.db
      .select({ one: sql`1` })
      .from(ownerCommit)
      .innerJoin(ownerDeck, eq(ownerDeck.id, ownerCommit.deckId))
      .where(and(eq(ownerCommit.id, commit), eq(ownerDeck.workspaceId, ctx.workspaceId))),
  );
}

/**
 * Runs a write whose only failure mode for valid input is a dangling reference, and
 * reports a violated foreign key as a `not-found` {@link RepositoryError}. Works for
 * every connection mode: the violation is recognized through the error's cause chain
 * (`DrizzleQueryError` → `LibsqlError`), with or without an extended result code.
 */
export async function referencing<T>(what: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (classifySqlError(error).kind === 'foreign-key') {
      throw new RepositoryError('not-found', `${what} references a row that does not exist`, {
        cause: error,
      });
    }
    throw error;
  }
}

/** Whether `error` is (or wraps) a UNIQUE or PRIMARY KEY violation. */
export function isUniqueViolation(error: unknown): boolean {
  return classifySqlError(error).kind === 'unique';
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

/**
 * `(VALUES (?), (?), ...)`: a one-column table of `values` (its column is `column1`), for
 * looking rows up by many keys: `FROM ${valuesTable(keys)} AS wanted CROSS JOIN t WHERE
 * t.key = wanted.column1`.
 *
 * Remote libSQL counts the rows of the temporary table SQLite builds for `key IN (?, ?,
 * ...)` as rows read, twice: such a lookup reads three rows per key (308 rows for the 103
 * cards of a deck, measured on sqld 0.24.32), this join one (103). `CROSS JOIN` keeps the
 * values the outer loop. Pass distinct values, at most {@link BATCH_SIZE} of them.
 */
export function valuesTable(values: readonly string[]): SQL {
  return sql`(VALUES ${sql.join(
    values.map((value) => sql`(${value})`),
    sql`, `,
  )})`;
}

/** The value an upsert tried to insert into `column` (SQLite's `excluded` pseudo-table). */
export function excluded(column: SQLiteColumn): SQL {
  return sql.raw(`excluded."${column.name}"`);
}

/** Distinct values in first-seen order. */
export function distinct<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/**
 * Largest value the repositories store in one column, in bytes (raw payloads after
 * compression, canonical snapshot JSON, other JSON columns). Remote libSQL (Turso) rejects
 * any value, bound argument or row larger than 5,000,000 bytes; this leaves room for the
 * row's other columns and fails early with a clear message instead of a driver error.
 */
export const MAX_STORED_VALUE_BYTES = 4_500_000;

/**
 * @throws {RepositoryError} `invalid-input` when a value of `byteLength` bytes is too large
 *   to store (see {@link MAX_STORED_VALUE_BYTES}).
 */
export function assertStorableSize(what: string, byteLength: number): void {
  if (byteLength <= MAX_STORED_VALUE_BYTES) return;
  throw new RepositoryError(
    'invalid-input',
    `${what} is too large to store: ${byteLength.toLocaleString('en-US')} bytes, the limit is ` +
      `${MAX_STORED_VALUE_BYTES.toLocaleString('en-US')} bytes`,
  );
}
