/**
 * Bounded concurrency for independent database reads. Remotely (Turso) every query is an
 * HTTP round trip, so reads that do not depend on each other are worth starting together;
 * a bound keeps a long list (every deck of a workspace) from opening hundreds of requests
 * at once. Locally every operation is serialized by the database's write lock anyway, so
 * running them together costs nothing there either.
 */

/** Default bound for {@link mapConcurrently}. */
export const DEFAULT_CONCURRENCY = 8;

/**
 * Maps `items` with `fn`, running at most `limit` calls at a time, and returns the results
 * in the order of `items`. Rejects with the first failure; calls already running are not
 * cancelled (their results are ignored), and no new ones start after it.
 */
export async function mapConcurrently<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit = DEFAULT_CONCURRENCY,
): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
