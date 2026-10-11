/**
 * Garbage collection of the content-addressed stores. Snapshots and raw blobs are shared
 * by every commit and observation with the same content, so deleting a deck or pruning
 * observations removes a row of a store only when nothing references it any more.
 * Internal to `src/server/repositories`.
 *
 * Every table that stores a snapshot or raw blob hash must be listed in
 * {@link referencedBy}, or collecting garbage would delete content that is still in use.
 * Run it inside the transaction that removed the referencing rows.
 */
import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

import { commits, observations, rawBlobs, snapshots } from '@/server/db/schema';

import { sumInBatches, type LibsqlExecutor } from './context';

/** A reference to stored content from a commit or observation (a commit may have no raw blob). */
export interface ContentReference {
  snapshotHash: string;
  rawBlobHash: string | null;
}

/** The columns that reference each store's rows. */
const referencedBy = {
  snapshots: [commits.snapshotHash, observations.snapshotHash],
  rawBlobs: [commits.rawBlobHash, observations.rawBlobHash],
} as const;

/**
 * Deletes those of `hashes` (values of the store's `key` column) that none of
 * `referencing` points at. Returns how many rows were deleted.
 */
async function deleteUnreferenced(
  db: LibsqlExecutor,
  key: SQLiteColumn,
  referencing: readonly SQLiteColumn[],
  hashes: readonly string[],
): Promise<number> {
  return sumInBatches(hashes, async (batch) => {
    const result = await db.delete(key.table).where(
      and(
        inArray(key, batch),
        ...referencing.map((column) =>
          notExists(
            db
              .select({ one: sql`1` })
              .from(column.table)
              .where(eq(column, key)),
          ),
        ),
      ),
    );
    return result.rowsAffected;
  });
}

/**
 * Deletes the snapshots and raw blobs among `references` that no commit or observation
 * references any more (a snapshot's `snapshot_cards` rows cascade). Returns how many of
 * each were deleted.
 */
export async function collectContentGarbage(
  db: LibsqlExecutor,
  references: readonly ContentReference[],
): Promise<{ snapshots: number; rawBlobs: number }> {
  const snapshotCount = await deleteUnreferenced(
    db,
    snapshots.hash,
    referencedBy.snapshots,
    references.map((reference) => reference.snapshotHash),
  );
  const rawBlobCount = await deleteUnreferenced(
    db,
    rawBlobs.hash,
    referencedBy.rawBlobs,
    references.flatMap((reference) => (reference.rawBlobHash === null ? [] : [reference.rawBlobHash])),
  );
  return { snapshots: snapshotCount, rawBlobs: rawBlobCount };
}
