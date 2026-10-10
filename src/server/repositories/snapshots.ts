/**
 * Content-addressed store of canonical snapshots plus the derived `snapshot_cards`
 * index used by card history and search.
 */
import { and, eq, inArray, notExists, sql } from 'drizzle-orm';

import { canonicalizeSnapshot, stableStringify } from '@/core/canonical';
import { snapshotHash } from '@/core/hash';
import { SNAPSHOT_SCHEMA_VERSION, type CanonicalSnapshot } from '@/core/model';
import { commits, observations, snapshotCards, snapshots } from '@/server/db/schema';

import { corruptData, decodeJson, isRecord } from './codec';
import { batches, distinct, withTransaction, type DbExecutor, type RepositoryContext } from './context';
import { RepositoryError } from './errors';

export interface SnapshotRepository {
  /**
   * Stores a snapshot and indexes its cards; returns its content hash
   * (`snapshotHash(snapshot)`). Idempotent: storing an already-known snapshot is a
   * no-op that returns the same hash.
   *
   * @throws {RepositoryError} `invalid-input` unless the snapshot is exactly what
   * `canonicalizeSnapshot` produces (content addressing requires canonical bytes).
   */
  put(snapshot: CanonicalSnapshot): string;
  /**
   * Loads a snapshot by hash, or `null` when unknown.
   * @throws {RepositoryError} `unsupported-version` for snapshots written with another schema version.
   */
  get(hash: string): CanonicalSnapshot | null;
  /** Loads several snapshots at once. Unknown hashes are absent from the result. */
  getMany(hashes: Iterable<string>): Map<string, CanonicalSnapshot>;
}

export function createSnapshotRepository(ctx: RepositoryContext): SnapshotRepository {
  return {
    put(snapshot) {
      assertCanonical(snapshot);
      const canonicalJson = stableStringify(snapshot);
      const hash = snapshotHash(snapshot);
      withTransaction(ctx, ({ db }) => {
        const inserted = db
          .insert(snapshots)
          .values({ hash, schemaVersion: snapshot.schemaVersion, canonicalJson, createdAt: ctx.now() })
          .onConflictDoNothing()
          .run();
        // A known snapshot was indexed when it was first stored.
        if (inserted.changes === 0) return;
        const rows = Object.entries(snapshot.zones).flatMap(([zone, cards]) =>
          (cards ?? []).map((card) => ({
            snapshotHash: hash,
            zone,
            cardKey: card.key,
            name: card.name,
            quantity: card.quantity,
          })),
        );
        for (const batch of batches(rows)) db.insert(snapshotCards).values(batch).onConflictDoNothing().run();
      });
      return hash;
    },

    get(hash) {
      const row = ctx.db.select().from(snapshots).where(eq(snapshots.hash, hash)).get();
      return row ? decodeSnapshot(row) : null;
    },

    getMany(hashes) {
      const result = new Map<string, CanonicalSnapshot>();
      for (const batch of batches(distinct(hashes))) {
        const rows = ctx.db.select().from(snapshots).where(inArray(snapshots.hash, batch)).all();
        for (const row of rows) result.set(row.hash, decodeSnapshot(row));
      }
      return result;
    },
  };
}

function assertCanonical(snapshot: CanonicalSnapshot): void {
  let canonical: CanonicalSnapshot;
  try {
    canonical = canonicalizeSnapshot(snapshot);
  } catch (cause) {
    throw new RepositoryError('invalid-input', 'Snapshot is not valid', { cause });
  }
  if (stableStringify(canonical) !== stableStringify(snapshot)) {
    throw new RepositoryError(
      'invalid-input',
      'Snapshot is not in canonical form; produce it with canonicalizeSnapshot',
    );
  }
}

function decodeSnapshot(row: typeof snapshots.$inferSelect): CanonicalSnapshot {
  const what = `Snapshot ${row.hash}`;
  if (row.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new RepositoryError(
      'unsupported-version',
      `${what} uses schema version ${row.schemaVersion}; this build reads version ${SNAPSHOT_SCHEMA_VERSION}`,
    );
  }
  const value = decodeJson(row.canonicalJson, what);
  if (!isRecord(value) || value.schemaVersion !== row.schemaVersion || !isRecord(value.zones)) {
    throw corruptData(what, 'canonical JSON does not match the snapshot schema');
  }
  return value as unknown as CanonicalSnapshot;
}

/**
 * Deletes those of `hashes` that no commit or observation references any more
 * (their `snapshot_cards` rows cascade). Returns the number of snapshots deleted.
 */
export function deleteUnreferencedSnapshots(db: DbExecutor, hashes: readonly string[]): number {
  let deleted = 0;
  for (const batch of batches(distinct(hashes))) {
    deleted += db
      .delete(snapshots)
      .where(
        and(
          inArray(snapshots.hash, batch),
          notExists(
            db
              .select({ one: sql`1` })
              .from(commits)
              .where(eq(commits.snapshotHash, snapshots.hash)),
          ),
          notExists(
            db
              .select({ one: sql`1` })
              .from(observations)
              .where(eq(observations.snapshotHash, snapshots.hash)),
          ),
        ),
      )
      .run().changes;
  }
  return deleted;
}
