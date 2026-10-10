/**
 * Assertions about stored data the service layer relies on (a commit's parent and
 * snapshot exist, ...). A failure means the database is inconsistent, never that the
 * caller asked for something unknown, so it is a plain error (a 500), not a
 * `ServiceError` — unless the deck itself was deleted meanwhile ({@link unlessDeckVanished}).
 */
import type { CanonicalSnapshot } from '@/core/model';

/** Stored data that a read relies on is missing (see {@link requireRecord}). */
export class MissingRecordError extends Error {
  override readonly name = 'MissingRecordError';
}

/** `value`, or a {@link MissingRecordError} naming `what` as missing from the database. */
export function requireRecord<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined)
    throw new MissingRecordError(`${what} is missing from the database`);
  return value;
}

/** The snapshot `hash` from a batch loaded with `getMany`. */
export function requireSnapshot(
  snapshots: ReadonlyMap<string, CanonicalSnapshot>,
  hash: string,
): CanonicalSnapshot {
  return requireRecord(snapshots.get(hash), `Snapshot ${hash}`);
}

/**
 * Runs `read`, a read of one deck's history in several statements. What such a read relies
 * on (a version's parent, a version's snapshot) only goes missing with the deck itself, and
 * another request (or function instance) can delete the deck, untracking it, between any
 * two statements. So when something is missing, `deckExists` is asked again: when the deck
 * is gone, the read answers `whenGone`, as it would for a deck that does not exist, instead
 * of failing. Missing data of a deck that still exists is damage and fails as before.
 */
export async function unlessDeckVanished<T>(
  read: () => Promise<T>,
  deckExists: () => Promise<boolean>,
  whenGone: T,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof MissingRecordError) || (await deckExists())) throw error;
    return whenGone;
  }
}
