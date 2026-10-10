/**
 * Observations: fetches and captures of the live source deck. The latest one is the
 * deck's "working tree" that is compared against HEAD. Superseded observations are
 * pruned once nothing may still commit them ({@link ObservationRepository.pruneForDeck}).
 *
 * **An observation is read together with its snapshot, in one statement**
 * ({@link ObservationRepository.latestWithSnapshot}, {@link ObservationRepository.getWithSnapshot}),
 * never as an observation first and its snapshot after. Outside a transaction every statement
 * sees whatever is committed when it runs, and remotely another function instance can write
 * in between: two ingests of the deck there prune the observation just read, with the
 * snapshot only it referenced, and the second read would find the snapshot gone. One
 * statement reads one consistent state of the database, and the snapshot's foreign key
 * guarantees that it exists in that state. (A read transaction would also be consistent,
 * but costs a round trip per statement remotely; retrying after a vanished snapshot only
 * makes the failure less likely.)
 */
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';

import type { CanonicalSnapshot, IngestWarning, SourceDeckMetadata } from '@/core/model';
import type { IngestMethod } from '@/integrations/deck-source';
import { decks, observations, snapshots } from '@/server/db/schema';

import { corruptData, decodeIngestMethod, decodeSourceMetadata, decodeWarnings, encodeJson } from './codec';
import {
  deckInWorkspace,
  referencing,
  withTransaction,
  write,
  type LibsqlExecutor,
  type RepositoryContext,
} from './context';
import { RepositoryError } from './errors';
import { deleteUnreferencedRawBlobs } from './raw-blobs';
import { decodeSnapshot, deleteUnreferencedSnapshots } from './snapshots';

export interface ObservationRecord {
  id: string;
  deckId: string;
  snapshotHash: string;
  rawBlobHash: string;
  ingestMethod: IngestMethod;
  /** When the state was fetched/captured from the source (ISO). */
  fetchedAt: string;
  sourceVersion: number | null;
  sourceUpdatedAt: string | null;
  sourceMetadata: SourceDeckMetadata;
  warnings: IngestWarning[];
}

export type NewObservation = Omit<ObservationRecord, 'id'>;

/** An observation and the snapshot it records, read in one statement. */
export interface ObservationWithSnapshot {
  observation: ObservationRecord;
  snapshot: CanonicalSnapshot;
}

export interface ObservationRepository {
  /**
   * Records an observation. The snapshot and raw blob must already be stored.
   * @returns the stored record with its generated id.
   * @throws {RepositoryError} `not-found` when the deck, snapshot or raw blob is unknown.
   */
  insert(input: NewObservation): Promise<ObservationRecord>;
  getById(id: string): Promise<ObservationRecord | null>;
  /**
   * An observation with its snapshot, in one statement (see the module documentation).
   * @throws {RepositoryError} `corrupt-data` or `unsupported-version` for an unreadable row.
   */
  getWithSnapshot(id: string): Promise<ObservationWithSnapshot | null>;
  /**
   * The deck's working state: its latest observation (latest `fetchedAt`, ties broken by
   * insertion order) with its snapshot, in one statement (see the module documentation).
   * @throws {RepositoryError} `corrupt-data` or `unsupported-version` for an unreadable row.
   */
  latestWithSnapshot(deckId: string): Promise<ObservationWithSnapshot | null>;
  /**
   * Deletes the deck's observations except `keepIds`, then the snapshots and raw blobs
   * that no commit or remaining observation references any more (their card index rows
   * cascade). Atomic: its own transaction, or a savepoint of the caller's.
   * @returns the number of observations deleted.
   */
  pruneForDeck(deckId: string, keepIds: readonly string[]): Promise<number>;
}

export function createObservationRepository(ctx: RepositoryContext): ObservationRepository {
  /** Observations of decks in the context's workspace (for lookups by an observation's id). */
  const owned = () => deckInWorkspace(ctx, observations.deckId);

  return {
    async insert(input) {
      const deck = await ctx.db
        .select({ id: decks.id })
        .from(decks)
        .where(and(eq(decks.id, input.deckId), eq(decks.workspaceId, ctx.workspaceId)))
        .get();
      if (!deck) throw new RepositoryError('not-found', `Deck ${input.deckId} does not exist`);
      const record: ObservationRecord = { id: ctx.newId(), ...input };
      const values = {
        id: record.id,
        deckId: record.deckId,
        snapshotHash: record.snapshotHash,
        rawBlobHash: record.rawBlobHash,
        ingestMethod: record.ingestMethod,
        fetchedAt: record.fetchedAt,
        sourceVersion: record.sourceVersion,
        sourceUpdatedAt: record.sourceUpdatedAt,
        sourceMetadataJson: encodeJson(record.sourceMetadata, 'Source metadata'),
        warningsJson: encodeJson(record.warnings, 'Ingest warnings'),
      };
      await referencing('Observation', () => write(ctx, (db) => db.insert(observations).values(values)));
      return record;
    },

    async getById(id) {
      const row = await ctx.db
        .select()
        .from(observations)
        .where(and(eq(observations.id, id), owned()))
        .get();
      return row ? toObservationRecord(row) : null;
    },

    async getWithSnapshot(id) {
      const row = await withSnapshot(ctx.db)
        .where(and(eq(observations.id, id), owned()))
        .get();
      return row ? toObservationWithSnapshot(row) : null;
    },

    async latestWithSnapshot(deckId) {
      const row = await latestWithSnapshotQuery(ctx, deckId).get();
      return row ? toObservationWithSnapshot(row) : null;
    },

    pruneForDeck(deckId, keepIds) {
      return withTransaction(ctx, async (tx) => {
        const { db } = tx;
        const superseded = and(
          eq(observations.deckId, deckId),
          deckInWorkspace(tx, deckId),
          keepIds.length === 0 ? undefined : notInArray(observations.id, [...keepIds]),
        );
        const references = await db
          .select({ snapshotHash: observations.snapshotHash, rawBlobHash: observations.rawBlobHash })
          .from(observations)
          .where(superseded)
          .all();
        if (references.length === 0) return 0;
        const deleted = await db.delete(observations).where(superseded);
        await deleteUnreferencedSnapshots(
          db,
          references.map((reference) => reference.snapshotHash),
        );
        await deleteUnreferencedRawBlobs(
          db,
          references.map((reference) => reference.rawBlobHash),
        );
        return deleted.rowsAffected;
      });
    },
  };
}

/**
 * Ordering that puts a deck's working state first: latest `fetchedAt`, ties broken by
 * insertion order (`rowid`).
 */
export const latestObservationFirst = [desc(observations.fetchedAt), desc(sql`${observations}.rowid`)];

/** Observations joined with their snapshots (`LEFT`, so that a missing one is reported). */
function withSnapshot(db: LibsqlExecutor) {
  return db
    .select({ observation: observations, snapshot: snapshots })
    .from(observations)
    .leftJoin(snapshots, eq(snapshots.hash, observations.snapshotHash));
}

/**
 * The deck's latest observation with its snapshot. Walks the deck's observations through
 * `observations_deck_fetched_idx` newest first, without sorting, so only the latest one's
 * snapshot is read.
 *
 * @internal exported for the query-plan tests.
 */
export function latestWithSnapshotQuery(ctx: Pick<RepositoryContext, 'db' | 'workspaceId'>, deckId: string) {
  return withSnapshot(ctx.db)
    .where(and(eq(observations.deckId, deckId), deckInWorkspace(ctx, deckId)))
    .orderBy(...latestObservationFirst)
    .limit(1);
}

function toObservationWithSnapshot(row: {
  observation: typeof observations.$inferSelect;
  snapshot: typeof snapshots.$inferSelect | null;
}): ObservationWithSnapshot {
  const observation = toObservationRecord(row.observation);
  // The foreign key keeps the snapshot while the observation exists, and one statement
  // reads both from the same state of the database: a missing one is damage.
  if (row.snapshot === null) {
    throw corruptData(`Observation ${observation.id}`, `its snapshot ${observation.snapshotHash} is missing`);
  }
  return { observation, snapshot: decodeSnapshot(row.snapshot) };
}

function toObservationRecord(row: typeof observations.$inferSelect): ObservationRecord {
  const what = `Observation ${row.id}`;
  return {
    id: row.id,
    deckId: row.deckId,
    snapshotHash: row.snapshotHash,
    rawBlobHash: row.rawBlobHash,
    ingestMethod: decodeIngestMethod(row.ingestMethod, what),
    fetchedAt: row.fetchedAt,
    sourceVersion: row.sourceVersion,
    sourceUpdatedAt: row.sourceUpdatedAt,
    sourceMetadata: decodeSourceMetadata(row.sourceMetadataJson, `${what} source metadata`),
    warnings: decodeWarnings(row.warningsJson, `${what} warnings`),
  };
}
