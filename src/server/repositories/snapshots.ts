/**
 * Content-addressed store of canonical snapshots plus the derived `snapshot_cards`
 * index used by card history and search.
 */
import { eq, sql, type SQL } from 'drizzle-orm';

import { canonicalizeSnapshot, stableStringify } from '@/core/canonical';
import { isRecord } from '@/core/guards';
import { sha256Hex, snapshotHash } from '@/core/hash';
import { SNAPSHOT_SCHEMA_VERSION, type CanonicalSnapshot } from '@/core/model';
import { snapshotCards, snapshots } from '@/server/db/schema';

import { corruptData, decodeJson } from './codec';
import {
  assertStorableSize,
  batches,
  selectInBatches,
  valuesTable,
  writeAll,
  type LibsqlExecutor,
  type RepositoryContext,
  type WriteSet,
} from './context';
import { RepositoryError } from './errors';

export interface SnapshotRepository {
  /**
   * Stores a snapshot and indexes its cards; returns its content hash
   * (`snapshotHash(snapshot)`). Idempotent: storing an already-known snapshot is a
   * no-op that returns the same hash. The snapshot and its card rows are written in one
   * atomic batch.
   *
   * @throws {RepositoryError} `invalid-input` unless the snapshot is exactly what
   * `canonicalizeSnapshot` produces (content addressing requires canonical bytes), or when
   * its canonical JSON is too large to store (`MAX_STORED_VALUE_BYTES`).
   */
  put(snapshot: CanonicalSnapshot): Promise<string>;
  /**
   * Loads a snapshot by hash, or `null` when unknown.
   * @throws {RepositoryError} `unsupported-version` for snapshots written with another schema version.
   */
  get(hash: string): Promise<CanonicalSnapshot | null>;
  /** Loads several snapshots at once. Unknown hashes are absent from the result. */
  getMany(hashes: Iterable<string>): Promise<Map<string, CanonicalSnapshot>>;
}

export function createSnapshotRepository(ctx: RepositoryContext): SnapshotRepository {
  return {
    async put(snapshot) {
      assertCanonical(snapshot);
      const canonicalJson = stableStringify(snapshot);
      const hash = snapshotHash(snapshot);
      assertSnapshotStorable(hash, canonicalJson);
      const createdAt = ctx.now();
      const known = await ctx.db
        .select({ hash: snapshots.hash })
        .from(snapshots)
        .where(eq(snapshots.hash, hash))
        .get();
      // A known snapshot was indexed when it was first stored.
      if (known) return hash;
      const rows = snapshotCardRows(hash, snapshot);
      // Snapshot and card index rows are written together or not at all. If another writer
      // stored the same snapshot since the check above, every insert is a no-op.
      await writeAll(ctx, (db) =>
        snapshotWriteStatements(
          db,
          [{ hash, schemaVersion: snapshot.schemaVersion, canonicalJson, createdAt }],
          rows,
        ),
      );
      return hash;
    },

    async get(hash) {
      const row = await ctx.db.select().from(snapshots).where(eq(snapshots.hash, hash)).get();
      return row ? decodeSnapshot(row) : null;
    },

    async getMany(hashes) {
      const result = new Map<string, CanonicalSnapshot>();
      // One row read per snapshot (a version list loads two per version).
      const rows = await selectInBatches(hashes, (batch) =>
        ctx.db.all<typeof snapshots.$inferSelect>(snapshotLookupQuery(batch)),
      );
      for (const row of rows) result.set(row.hash, decodeSnapshot(row));
      return result;
    },
  };
}

/**
 * The snapshots with the given hashes (distinct, at most `BATCH_SIZE`), one primary-key
 * probe per hash (see `valuesTable`).
 *
 * @internal exported for the query-plan tests.
 */
export function snapshotLookupQuery(hashes: readonly string[]): SQL {
  return sql`
    SELECT s.hash AS "hash", s.schema_version AS "schemaVersion",
      s.canonical_json AS "canonicalJson", s.created_at AS "createdAt"
    FROM ${valuesTable(hashes)} AS wanted
    CROSS JOIN snapshots AS s
    WHERE s.hash = wanted.column1`;
}

/** The `snapshot_cards` rows (card index) of a snapshot stored under `hash`. */
export function snapshotCardRows(
  hash: string,
  snapshot: CanonicalSnapshot,
): (typeof snapshotCards.$inferInsert)[] {
  return Object.entries(snapshot.zones).flatMap(([zone, cards]) =>
    (cards ?? []).map((card) => ({
      snapshotHash: hash,
      zone,
      cardKey: card.key,
      name: card.name,
      quantity: card.quantity,
    })),
  );
}

/**
 * The statements that store snapshot rows and their card index rows (see
 * {@link snapshotCardRows}) as one atomic write set. Rows that exist already are left as
 * they are.
 */
export function snapshotWriteStatements(
  db: LibsqlExecutor,
  rows: readonly [typeof snapshots.$inferInsert, ...(typeof snapshots.$inferInsert)[]],
  cards: readonly (typeof snapshotCards.$inferInsert)[],
): WriteSet {
  return [
    db
      .insert(snapshots)
      .values([...rows])
      .onConflictDoNothing(),
    ...batches(cards).map((batch) => db.insert(snapshotCards).values(batch).onConflictDoNothing()),
  ];
}

/**
 * @throws {RepositoryError} `invalid-input` when the canonical JSON of the snapshot stored
 * under `hash` is too large to store (see `MAX_STORED_VALUE_BYTES`).
 */
export function assertSnapshotStorable(hash: string, canonicalJson: string): void {
  assertStorableSize(`Snapshot ${hash}`, Buffer.byteLength(canonicalJson, 'utf8'));
}

/**
 * Decodes a snapshot row that was not written by this module, after checking its content
 * against its hash.
 * @throws {RepositoryError} `corrupt-data` when the content does not match the hash; see
 * {@link decodeSnapshot}.
 */
export function verifiedSnapshot(row: typeof snapshots.$inferSelect): CanonicalSnapshot {
  if (sha256Hex(row.canonicalJson) !== row.hash) {
    throw corruptData(`Snapshot ${row.hash}`, 'content does not match its hash');
  }
  return decodeSnapshot(row);
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

/**
 * Decodes a stored snapshot row.
 * @throws {RepositoryError} `unsupported-version` or `corrupt-data`.
 */
export function decodeSnapshot(row: typeof snapshots.$inferSelect): CanonicalSnapshot {
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
 * Decodes the snapshot a statement joined to `owner` (e.g. `Commit abc`): the foreign key
 * keeps the snapshot while the owner exists, and one statement reads both from the same
 * state of the database, so a missing row is damage.
 * @throws {RepositoryError} `corrupt-data` when `row` is missing; see {@link decodeSnapshot}.
 */
export function requireJoinedSnapshot(
  owner: string,
  snapshotHash: string,
  row: typeof snapshots.$inferSelect | null,
): CanonicalSnapshot {
  if (row === null) throw corruptData(owner, `its snapshot ${snapshotHash} is missing`);
  return decodeSnapshot(row);
}
