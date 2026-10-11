/**
 * Transactions and writes on libSQL databases: {@link runInTransaction} for read-check-write
 * units, {@link runWrite} for single statements and `db.batch()`.
 *
 * Rules for callers (enforced at runtime where possible):
 *
 * 1. **Every transaction goes through `runInTransaction`.** It takes the database's
 *    in-process write lock, opens a `BEGIN IMMEDIATE` transaction (the write lock is taken
 *    up front, so read-check-write sequences cannot interleave with other writers),
 *    retries the whole transaction on transient failures and keeps the original error.
 *    Calling `db.transaction()` directly throws (`unmanaged-transaction`).
 * 2. **Inside the callback use `tx`, never the root `db`.** Root-database calls inside the
 *    callback throw (`root-in-transaction`): remotely they would run on another stream
 *    outside the transaction (a write would wait for our own lock, and after 5 s the
 *    server would roll *our* transaction back); in memory they would fail with
 *    `TRANSACTION_ACTIVE`; on a file they would read stale data or fail with `SQLITE_BUSY`.
 * 3. **Keep transactions short and free of network I/O** (no Moxfield fetches, no `fetch`
 *    at all). Remotely every statement is an HTTPS round trip, and Turso rolls back a
 *    transaction that holds the write lock for more than 5 s while another writer waits.
 * 4. **The callback may run more than once.** It must not have effects outside the
 *    database (or they must be idempotent), and it must derive everything it writes from
 *    what it reads inside the transaction.
 * 5. **Do not swallow database errors inside the callback**, except constraint violations
 *    (`isConstraintViolation`), after which the transaction is still intact. After any
 *    other failure the transaction is *aborted*: further statements are not sent and the
 *    commit fails with {@link TransactionAbortedError}. Remotely this is what keeps a
 *    transaction atomic: after a server-side rollback (lock steal), the HTTP protocol would
 *    run later statements in autocommit mode and commit them one by one.
 * 6. **Lock order: deck mutex (service layer) first, write lock second.** Never wait for a
 *    deck mutex or any other lock inside a transaction.
 *
 * Statements on one transaction are executed one at a time in call order, even when the
 * callback issues them concurrently (`Promise.all`), so that a failure is seen before the
 * next statement is sent.
 *
 * Local databases (`file:`, `:memory:`) additionally run every root-database operation
 * under the write lock, so concurrent requests queue behind an open transaction instead of
 * failing (`TRANSACTION_ACTIVE` in memory, `SQLITE_BUSY` on a file). Remote root
 * operations run concurrently; the server serializes writers.
 */
import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import type {
  Client,
  InArgs,
  InStatement,
  Replicated,
  ResultSet,
  Transaction,
  TransactionMode,
} from '@libsql/client/http';
import { is } from 'drizzle-orm';
import { SQLiteTransaction } from 'drizzle-orm/sqlite-core';

import { CodedError } from '@/core/coded-error';
import { SerialQueue } from '@/core/serial-queue';

import { createLogger } from '../logger';
import type { LibsqlDb, LibsqlExecutor, LibsqlTx } from './libsql';
import {
  classifySqlError,
  isConstraintViolation,
  isSqlErrorKind,
  type SqlErrorClassification,
} from './sql-errors';
import { processSingleton } from '../process-singleton';
import type { WriteLock } from './write-lock';

const log = createLogger('db');

/** Retries after the first attempt, unless the caller says otherwise. */
export const DEFAULT_RETRIES = 3;
/** Delay before the first retry; doubles per retry (with jitter) up to {@link MAX_RETRY_DELAY_MS}. */
export const DEFAULT_RETRY_DELAY_MS = 25;
export const MAX_RETRY_DELAY_MS = 1_000;

export type DatabaseMisuseCode =
  /** The root database was used inside `runInTransaction` on the same database. */
  | 'root-in-transaction'
  /** `db.transaction()` (or `client.transaction()`) was called outside `runInTransaction`. */
  | 'unmanaged-transaction'
  /** The database was not created by `createLibsqlDatabase`. */
  | 'unmanaged-database';

/** A programming error in how the database is used. Never retried. */
export class DatabaseMisuseError extends CodedError<DatabaseMisuseCode> {
  override readonly name = 'DatabaseMisuseError';
}

/**
 * A transaction was used after a statement in it failed with something other than a
 * constraint violation (or its commit failed). Nothing it did is committed. `cause` is
 * that first failure, so classification and retry decisions follow it.
 */
export class TransactionAbortedError extends Error {
  override readonly name = 'TransactionAbortedError';

  constructor(cause: unknown) {
    super(
      'The transaction was aborted by an earlier failure and nothing it did is committed: ' +
        classifySqlError(cause).message,
      { cause },
    );
  }
}

export interface TransactionOptions {
  /**
   * How many times to run the whole transaction (or write) again after a retryable failure
   * (`busy`, `transaction-timeout`, `stream-expired`). Default {@link DEFAULT_RETRIES};
   * 0 disables retries.
   */
  retries?: number;
  /** Delay before the first retry in milliseconds. Default {@link DEFAULT_RETRY_DELAY_MS}. */
  retryDelayMs?: number;
  /** Give up waiting for the write lock after this long. Default: the database's `lockTimeoutMs`. */
  lockTimeoutMs?: number;
}

/** How a guarded client coordinates with the rest of the process. @internal for `libsql.ts`. */
export interface ClientGuard {
  /** The database's in-process write lock. */
  readonly lock: WriteLock;
  /** Default wait limit for the write lock. */
  readonly lockTimeoutMs: number;
  /**
   * Local databases: every root operation waits for the write lock, so all access to the
   * database is serialized and at most one pooled connection is in use at any time.
   */
  readonly serializeRootOperations: boolean;
  /**
   * Local files: after a `busy` failure, close and reopen every pooled connection (while
   * still holding the write lock). libSQL leaves the statement that failed with
   * `SQLITE_BUSY` active on its connection; that connection can then never commit again
   * ("cannot commit transaction - SQL statements in progress") and keeps later autocommit
   * writes in a transaction that never ends.
   */
  readonly recycleAfterBusy: boolean;
}

/** A guard plus the raw client it guards. */
interface GuardState extends ClientGuard {
  readonly inner: Client;
}

/** The transaction `runInTransaction` is opening or running on one client, in one async context. */
interface TransactionScope {
  state: 'starting' | 'open' | 'closed';
}

const scopeStorage = processSingleton(
  Symbol.for('git-moxfield.db.transactionScopes'),
  () => new AsyncLocalStorage<ReadonlyMap<Client, TransactionScope>>(),
);

/** Guard of every client created by {@link guardClient}, process-wide (survives HMR). */
const guards = processSingleton(
  Symbol.for('git-moxfield.db.clientGuards'),
  () => new WeakMap<Client, GuardState>(),
);

function activeScope(client: Client): TransactionScope | undefined {
  const scope = scopeStorage.getStore()?.get(client);
  return scope?.state === 'closed' ? undefined : scope;
}

function rootInTransactionError(): DatabaseMisuseError {
  return new DatabaseMisuseError(
    'root-in-transaction',
    'The root database was used inside runInTransaction() on the same database. Inside the ' +
      'callback, run every query on the transaction (tx) it received.',
  );
}

/** Failure details that are safe to log (never a query's bound parameters). */
function describeFailure(failure: SqlErrorClassification): Record<string, unknown> {
  return { kind: failure.kind, code: failure.code, reason: failure.message };
}

/** `Client.reconnect()` is typed `void`, but every implementation returns a promise. */
interface Reconnectable {
  reconnect(): unknown;
}

/**
 * After `error`, reopens the connections of a local file database if the error was a lock
 * conflict (see {@link ClientGuard.recycleAfterBusy}). Must run while the caller holds the
 * write lock, so that no other operation is using a connection.
 */
async function recoverFrom(state: GuardState, error: unknown): Promise<void> {
  if (!state.recycleAfterBusy || !isSqlErrorKind(error, 'busy')) return;
  try {
    await (state.inner as unknown as Reconnectable).reconnect();
    log.info('Reopened the local database connections after a lock conflict');
  } catch (reconnectError) {
    log.warn(
      'Reopening the local database connections failed',
      describeFailure(classifySqlError(reconnectError)),
    );
  }
}

/**
 * Wraps a transaction of the raw client: runs its statements one at a time, aborts it after
 * the first non-constraint failure, and never lets a failing rollback hide the error that
 * caused the rollback (a rollback that fails leaves nothing behind either: the connection
 * is rolled back or dropped by the pool, the remote stream is closed).
 */
class GuardedTransaction implements Transaction {
  readonly #inner: Transaction;
  /** Runs the operations one after another. */
  readonly #queue = new SerialQueue();
  /** The failure that aborted the transaction. */
  #abort: { readonly error: unknown } | undefined;

  constructor(inner: Transaction) {
    this.#inner = inner;
  }

  get closed(): boolean {
    return this.#inner.closed;
  }

  execute(stmt: InStatement): Promise<ResultSet> {
    return this.#statement(() => this.#inner.execute(stmt));
  }

  batch(stmts: InStatement[]): Promise<ResultSet[]> {
    return this.#statement(() => this.#inner.batch(stmts));
  }

  executeMultiple(sql: string): Promise<void> {
    return this.#statement(() => this.#inner.executeMultiple(sql));
  }

  commit(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#abort !== undefined) throw new TransactionAbortedError(this.#abort.error);
      try {
        await this.#inner.commit();
      } catch (error) {
        this.#abort = { error };
        throw error;
      }
    });
  }

  rollback(): Promise<void> {
    return this.#enqueue(async () => {
      try {
        await this.#inner.rollback();
      } catch (error) {
        // Expected after a server-side rollback (TRANSACTION_TIMEOUT, "no transaction is
        // active"); the caller is already propagating the error that matters.
        const failure = classifySqlError(error);
        if (this.#abort === undefined)
          log.warn('Rolling back a transaction failed', describeFailure(failure));
        else log.debug('Rolling back an aborted transaction failed', describeFailure(failure));
      } finally {
        this.#inner.close();
      }
    });
  }

  close(): void {
    this.#inner.close();
  }

  #statement<T>(operation: () => Promise<T>): Promise<T> {
    return this.#enqueue(async () => {
      if (this.#abort !== undefined) throw new TransactionAbortedError(this.#abort.error);
      try {
        return await operation();
      } catch (error) {
        if (!isConstraintViolation(classifySqlError(error).kind)) this.#abort ??= { error };
        throw error;
      }
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return this.#queue.run(operation);
  }
}

/**
 * A libSQL client that enforces the rules above: transactions only through
 * `runInTransaction` (always `BEGIN IMMEDIATE`, independent of the client's deprecated
 * default mode), no root operations inside one, and, for local databases, root operations
 * queued behind the write lock.
 */
class GuardedClient implements Client {
  readonly #inner: Client;
  readonly #state: GuardState;

  constructor(state: GuardState) {
    this.#inner = state.inner;
    this.#state = state;
  }

  get closed(): boolean {
    return this.#inner.closed;
  }

  get protocol(): string {
    return this.#inner.protocol;
  }

  execute(stmt: InStatement): Promise<ResultSet>;
  execute(sql: string, args?: InArgs): Promise<ResultSet>;
  execute(stmtOrSql: InStatement, args?: InArgs): Promise<ResultSet> {
    return this.#root(() =>
      typeof stmtOrSql === 'string' && args !== undefined
        ? this.#inner.execute(stmtOrSql, args)
        : this.#inner.execute(stmtOrSql),
    );
  }

  batch(stmts: (InStatement | [string, InArgs?])[], mode?: TransactionMode): Promise<ResultSet[]> {
    return this.#root(() => this.#inner.batch(stmts, mode));
  }

  migrate(stmts: InStatement[]): Promise<ResultSet[]> {
    return this.#root(() => this.#inner.migrate(stmts));
  }

  executeMultiple(sql: string): Promise<void> {
    return this.#root(() => this.#inner.executeMultiple(sql));
  }

  async transaction(mode: TransactionMode = 'write'): Promise<Transaction> {
    const scope = scopeStorage.getStore()?.get(this);
    if (scope?.state === 'open') throw rootInTransactionError();
    if (scope?.state !== 'starting') {
      throw new DatabaseMisuseError(
        'unmanaged-transaction',
        'Transactions must be opened with runInTransaction() (src/server/db/transaction.ts), ' +
          'which holds the write lock, retries transient failures and keeps transactions atomic.',
      );
    }
    const inner = await this.#inner.transaction(mode);
    scope.state = 'open';
    return new GuardedTransaction(inner);
  }

  sync(): Promise<Replicated> {
    return this.#inner.sync();
  }

  close(): void {
    this.#inner.close();
  }

  reconnect(): void {
    this.#inner.reconnect();
  }

  #root<T>(operation: () => Promise<T>): Promise<T> {
    if (activeScope(this) !== undefined) return Promise.reject(rootInTransactionError());
    const state = this.#state;
    const run = async (): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        await recoverFrom(state, error);
        throw error;
      }
    };
    if (!state.serializeRootOperations || state.lock.isHeldByCurrentContext()) return run();
    return state.lock.run(run, { timeoutMs: state.lockTimeoutMs });
  }
}

/**
 * Wraps a raw libSQL client so that it enforces the transaction rules of this module.
 *
 * @internal for `createLibsqlDatabase`.
 */
export function guardClient(client: Client, guard: ClientGuard): Client {
  const state: GuardState = { ...guard, inner: client };
  const guarded = new GuardedClient(state);
  guards.set(guarded, state);
  return guarded;
}

/** Whether `db` is a transaction (as passed to a `runInTransaction` callback) rather than the root database. */
export function isTransaction(db: LibsqlExecutor): db is LibsqlTx {
  return is(db, SQLiteTransaction);
}

function managedClient(db: LibsqlExecutor): { client: Client; guard: GuardState } {
  const client = (db as Partial<Pick<LibsqlDb, '$client'>>).$client;
  const guard = client === undefined ? undefined : guards.get(client);
  if (client === undefined || guard === undefined) {
    throw new DatabaseMisuseError(
      'unmanaged-database',
      'The database was not opened with createLibsqlDatabase() (src/server/db/libsql.ts), so its ' +
        'transactions cannot be coordinated.',
    );
  }
  return { client, guard };
}

function retryDelay(baseMs: number, retry: number): number {
  const ceiling = Math.min(MAX_RETRY_DELAY_MS, baseMs * 2 ** retry);
  return Math.round(ceiling / 2 + (Math.random() * ceiling) / 2);
}

async function withRetries<T>(
  options: TransactionOptions,
  what: string,
  attempt: () => Promise<T>,
): Promise<T> {
  const retries = Math.max(0, Math.floor(options.retries ?? DEFAULT_RETRIES));
  const baseDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  for (let retry = 0; ; retry++) {
    try {
      return await attempt();
    } catch (error) {
      const failure = classifySqlError(error);
      if (!failure.retryable || retry >= retries) throw error;
      const delayMs = retryDelay(baseDelayMs, retry);
      log.warn(`Retrying a database ${what} after a transient failure`, {
        ...describeFailure(failure),
        retry: retry + 1,
        retries,
        delayMs,
      });
      await sleep(delayMs);
    }
  }
}

async function attemptTransaction<T>(
  db: LibsqlExecutor,
  client: Client,
  guard: GuardState,
  fn: (tx: LibsqlTx) => Promise<T>,
): Promise<T> {
  const scope: TransactionScope = { state: 'starting' };
  const scopes = new Map(scopeStorage.getStore() ?? []);
  scopes.set(client, scope);
  let callbackFailure: { readonly error: unknown } | undefined;
  try {
    return await scopeStorage.run(scopes, () =>
      db.transaction(async (tx) => {
        try {
          return await fn(tx);
        } catch (error) {
          callbackFailure = { error };
          throw error;
        }
      }),
    );
  } catch (error) {
    await recoverFrom(guard, error);
    // The guarded transaction never fails a rollback; this covers a driver that does.
    if (callbackFailure !== undefined && error !== callbackFailure.error) {
      log.warn('Rolling back a failed transaction failed', describeFailure(classifySqlError(error)));
      throw callbackFailure.error;
    }
    throw error;
  } finally {
    scope.state = 'closed';
  }
}

/**
 * Runs `fn` in a write transaction and returns its result: commits when `fn` resolves,
 * rolls back and rethrows `fn`'s error (the original error object) when it rejects.
 *
 * With the root database: waits for the database's write lock, opens `BEGIN IMMEDIATE`,
 * and runs the *whole* transaction again (up to `options.retries` times, with a short
 * exponential backoff) when it fails with a retryable error (`busy`,
 * `transaction-timeout`, `stream-expired`, also when wrapped in a cause chain).
 *
 * With a transaction (`tx` from an enclosing `runInTransaction`): runs `fn` in a
 * savepoint; a failure rolls back only what `fn` did and propagates. No lock, no retry
 * (a retryable failure aborts the enclosing transaction, which is retried as a whole).
 *
 * See the module documentation for the rules `fn` must follow.
 *
 * @throws {DatabaseMisuseError} `unmanaged-database` for a database not opened with
 *   `createLibsqlDatabase`.
 * @throws {WriteLockError} `reentrant` (at once) when called with the root database from
 *   inside `runInTransaction`/`runWrite` on the same database; `timeout` when the write
 *   lock is not granted within `lockTimeoutMs`. Neither is retried.
 */
export async function runInTransaction<T>(
  db: LibsqlExecutor,
  fn: (tx: LibsqlTx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  if (isTransaction(db)) return db.transaction(fn);
  const { client, guard } = managedClient(db);
  const timeoutMs = options.lockTimeoutMs ?? guard.lockTimeoutMs;
  return withRetries(options, 'transaction', () =>
    guard.lock.run(() => attemptTransaction(db, client, guard, fn), { timeoutMs }),
  );
}

/**
 * Runs `fn` while holding the database's write lock, retrying it like
 * {@link runInTransaction} on retryable failures. For writes that are atomic on their own
 * and need no transaction: a single statement, or a `db.batch([...])` (one round trip,
 * all-or-nothing; prefer it for bulk writes that need no reads in between).
 *
 * `fn` receives the root database; it may run several statements, but they are not
 * atomic together, and a retry runs all of them again, so each must be idempotent.
 */
export async function runWrite<T>(
  db: LibsqlDb,
  fn: (db: LibsqlDb) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const { guard } = managedClient(db);
  const timeoutMs = options.lockTimeoutMs ?? guard.lockTimeoutMs;
  return withRetries(options, 'write', () => guard.lock.run(() => fn(db), { timeoutMs }));
}
