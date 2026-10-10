/**
 * Assertions about stored data the service layer relies on (a commit's parent and
 * snapshot exist, ...). A failure means the database is inconsistent, never that the
 * caller asked for something unknown, so it is a plain `Error` (a 500), not a
 * `ServiceError`.
 */
import type { CanonicalSnapshot } from '@/core/model';

/** `value`, or an error naming `what` as missing from the database. */
export function requireRecord<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} is missing from the database`);
  return value;
}

/** The snapshot `hash` from a batch loaded with `getMany`. */
export function requireSnapshot(
  snapshots: ReadonlyMap<string, CanonicalSnapshot>,
  hash: string,
): CanonicalSnapshot {
  return requireRecord(snapshots.get(hash), `Snapshot ${hash}`);
}
