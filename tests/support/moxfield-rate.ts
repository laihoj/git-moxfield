/**
 * Helpers for the tests of the installation-wide Moxfield request limiter (ADR 0009): many
 * "instances" admitting requests at once, and the spacing of the requests they would send.
 * Free of test-runner imports, so worker processes of the remote suite can use them.
 */
import type { DatabaseMoxfieldLimiter } from '@/server/moxfield-limiter';

/** The gaps between consecutive start times (sorted first), and the smallest of them. */
export function startSpacing(starts: readonly number[]): { gaps: number[]; min: number } {
  const sorted = [...starts].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((start, index) => start - (sorted[index] ?? start));
  return { gaps, min: gaps.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...gaps) };
}

/** Wall-clock time in milliseconds with sub-millisecond precision, comparable across processes on one machine. */
export function preciseNow(): number {
  return performance.timeOrigin + performance.now();
}

/** A monotonic clock that is `offsetMs` off (an instance whose clock is skewed). */
export function skewedClock(offsetMs: number): () => number {
  return () => performance.now() + offsetMs;
}

/**
 * Admits `requests` requests one after the other through `limiter`, as one instance whose
 * users keep refreshing, and returns when each would have been sent (`preciseNow`).
 * Refusals are returned as their error codes instead.
 */
export async function admitSequentially(
  limiter: DatabaseMoxfieldLimiter,
  requests: number,
): Promise<{ starts: number[]; refusals: string[] }> {
  const starts: number[] = [];
  const refusals: string[] = [];
  for (let request = 0; request < requests; request++) {
    try {
      await limiter.admit();
      starts.push(preciseNow());
    } catch (error) {
      refusals.push(
        error instanceof Error
          ? `${(error as { code?: string }).code ?? 'error'}: ${error.message}`
          : String(error),
      );
    }
  }
  return { starts, refusals };
}
