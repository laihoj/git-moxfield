/**
 * Per-key asynchronous mutual exclusion.
 *
 * The service layer serializes every operation that reads and then writes a deck's
 * working state or history (refresh, capture ingestion, commit, untrack) per deck, so
 * that, for example, a commit's fetch-on-commit can never interleave with a refresh of
 * the same deck. Operations on different decks run concurrently.
 */
export class KeyedMutex {
  /** Per key: a promise that settles (never rejects) when the last queued task is done. */
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Runs `task` once every task previously queued for `key` has settled, and returns
   * its result. A failing task does not affect the tasks queued after it.
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return result;
  }

  /** Whether a task for `key` is running or queued (diagnostics and tests). */
  isLocked(key: string): boolean {
    return this.tails.has(key);
  }
}
