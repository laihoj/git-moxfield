/**
 * Garbage collection of the content-addressed stores: a snapshot or raw blob is deleted
 * only when no commit or observation references it any more. Every column that stores a
 * snapshot or raw blob hash must be listed in {@link referencedBy}, or content still in use
 * would be deleted. Internal to `src/server/repositories`.
 */
import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

import { commits, observations, rawBlobs, snapshots } from '@/server/db/schema';

import { batches, distinct, type LibsqlExecutor } from './context';

/** A reference to stored content from a commit or observation (a commit may have no raw blob). */
interface ContentReference {
  snapshotHash: string;
  rawBlobHash: string | null;
}

/** The columns that reference each store's rows. */
const referencedBy = {
  snapshots: [commits.snapshotHash, observations.snapshotHash],
  rawBlobs: [commits.rawBlobHash, observations.rawBlobHash],
} as const;

/** Deletes those of `hashes` (values of the store's `key` column) that none of `referencing` points at. */
async function deleteUnreferenced(
  db: LibsqlExecutor,
  key: SQLiteColumn,
  referencing: readonly SQLiteColumn[],
  hashes: readonly string[],
): Promise<void> {
  for (const batch of batches(distinct(hashes))) {
    await db.delete(key.table).where(
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
  }
}

/**
 * Deletes the snapshots (their `snapshot_cards` rows cascade) and raw blobs among
 * `references` that nothing references any more. Run it inside the transaction that
 * removed the referencing rows.
 */
export async function collectContentGarbage(
  db: LibsqlExecutor,
  references: readonly ContentReference[],
): Promise<void> {
  await deleteUnreferenced(
    db,
    snapshots.hash,
    referencedBy.snapshots,
    references.map((reference) => reference.snapshotHash),
  );
  await deleteUnreferenced(
    db,
    rawBlobs.hash,
    referencedBy.rawBlobs,
    references.flatMap((reference) => (reference.rawBlobHash === null ? [] : [reference.rawBlobHash])),
  );
}
