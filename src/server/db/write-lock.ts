/**
 * In-process write lock: a FIFO async mutex that serializes the write transactions (and,
 * for local databases, every operation; see `transaction.ts`) one process sends to one
 * database.
 *
 * Why it exists: libSQL rejects instead of queueing when one process opens two writers
 * on a local database. An in-memory database has a single connection, so a second
 * transaction fails with `TRANSACTION_ACTIVE`; a `file:` database fails with
 * `SQLITE_BUSY` at once (or, with a busy timeout, blocks the event loop while the holder,
 * which runs on that same event loop, can never finish). Remote databases queue writers
 * on the server, where the lock is merely harmless.
 *
 * Guarantees:
 * - **FIFO, no starvation.** Ownership passes directly from the releasing task to the
 *   oldest waiter, so a newcomer can never overtake a task that is already waiting.
 * - **No self-deadlock.** The lock knows (through `AsyncLocalStorage`) which async
 *   context holds it. A second `run()` from inside a task fails at once with a
 *   `reentrant` {@link WriteLockError} instead of waiting for itself forever.
 * - **Bounded waits.** A waiter can give up after `timeoutMs` (`timeout` error); the
 *   queue behind it is unaffected.
 *
 * Locks shared by URL ({@link sharedWriteLock}) and the holder bookkeeping live on
 * `globalThis`, so every module instance (dev-server HMR, separate route bundles in one
 * process) uses the same lock for the same database.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { CodedError } from '@/core/coded-error';

import { processSingleton } from '../process-singleton';

/** Why {@link WriteLock.run} gave up without running the task. */
export type WriteLockErrorCode =
  /** The calling async context already holds this lock (a nested write on the root database). */
  | 'reentrant'
  /** The lock was not granted within the requested `timeoutMs`. */
  | 'timeout';

export class WriteLockError extends CodedError<WriteLockErrorCode> {
  override readonly name = 'WriteLockError';
}

export interface WriteLockRunOptions {
  /**
   * Give up waiting after this many milliseconds with a `timeout` {@link WriteLockError}.
   * Default: wait as long as it takes. Has no effect once the task runs.
   */
  timeoutMs?: number;
}

/** One grant of a lock to one task. `released` flips when the task settles. */
interface Hold {
  readonly lock: WriteLock;
  released: boolean;
}

/** The holds of the current async context (outermost first). */
const holdsStorage = processSingleton(
  Symbol.for('git-moxfield.db.writeLockHolds'),
  () => new AsyncLocalStorage<readonly Hold[]>(),
);

interface Waiter {
  /** Hands the lock to this waiter (the lock stays held throughout the handover). */
  readonly grant: () => void;
}

export class WriteLock {
  /** Diagnostic name (a redacted database URL or `memory`), used in error messages. */
  readonly name: string;
  #held = false;
  readonly #waiters: Waiter[] = [];

  constructor(name: string) {
    this.name = name;
  }

  /** Whether a task holds the lock right now. */
  get locked(): boolean {
    return this.#held;
  }

  /** Number of tasks waiting for the lock. */
  get queueLength(): number {
    return this.#waiters.length;
  }

  /**
   * Whether the calling async context is inside a task that holds this lock. Work a task
   * started but that runs after the task settled (an un-awaited promise, a timer) is not.
   */
  isHeldByCurrentContext(): boolean {
    return holdsStorage.getStore()?.some((hold) => hold.lock === this && !hold.released) ?? false;
  }

  /**
   * Runs `task` once every task queued before it has settled, holding the lock until
   * `task` settles, and returns its result. A failing task releases the lock like a
   * successful one.
   *
   * @throws {WriteLockError} `reentrant` (at once, without queueing) when the calling async
   *   context already holds this lock; `timeout` when `options.timeoutMs` elapses first.
   */
  async run<T>(task: () => Promise<T> | T, options: WriteLockRunOptions = {}): Promise<T> {
    if (this.isHeldByCurrentContext()) {
      throw new WriteLockError(
        'reentrant',
        `The write lock of ${this.name} is already held by this async context. A write on the ` +
          'root database inside runInTransaction()/runWrite() would wait for itself forever; ' +
          'use the transaction (tx) the callback received instead.',
      );
    }
    await this.#acquire(options.timeoutMs);
    const hold: Hold = { lock: this, released: false };
    const outer = (holdsStorage.getStore() ?? []).filter((existing) => !existing.released);
    try {
      // Await inside the scope: a lazy thenable (a Drizzle query builder) returned by `task`
      // only runs when awaited, and must still see the hold then.
      return await holdsStorage.run([...outer, hold], async () => await task());
    } finally {
      hold.released = true;
      this.#release();
    }
  }

  #acquire(timeoutMs: number | undefined): Promise<void> {
    if (!this.#held) {
      this.#held = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        grant: () => {
          if (timer !== undefined) clearTimeout(timer);
          resolve();
        },
      };
      if (timeoutMs !== undefined && Number.isFinite(timeoutMs)) {
        timer = setTimeout(
          () => {
            const index = this.#waiters.indexOf(waiter);
            if (index === -1) return; // granted in the meantime
            this.#waiters.splice(index, 1);
            reject(
              new WriteLockError(
                'timeout',
                `Waited more than ${timeoutMs} ms for the write lock of ${this.name}. A transaction ` +
                  'held it all that time: either it is slow (transactions must stay short and never ' +
                  'wait for network I/O) or it awaits work that itself needs the database outside ' +
                  'the transaction, which is a deadlock.',
              ),
            );
          },
          Math.max(0, timeoutMs),
        );
      }
      this.#waiters.push(waiter);
    });
  }

  #release(): void {
    const next = this.#waiters.shift();
    // Direct handover: `#held` stays true, so nobody can barge in between.
    if (next) next.grant();
    else this.#held = false;
  }
}

/** Locks shared per database (by key) across the whole process. */
const sharedLocks = processSingleton(
  Symbol.for('git-moxfield.db.sharedWriteLocks'),
  () => new Map<string, WriteLock>(),
);

/**
 * The process-wide lock for `key`, created on first use. Every connection to the same
 * database must use the same key (see `libsql.ts`), so that two clients opened on one
 * file serialize their writers too. Keys must not contain secrets: they appear in error
 * messages.
 */
export function sharedWriteLock(key: string): WriteLock {
  let lock = sharedLocks.get(key);
  if (lock === undefined) {
    lock = new WriteLock(key);
    sharedLocks.set(key, lock);
  }
  return lock;
}
