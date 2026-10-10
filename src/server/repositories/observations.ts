/**
 * Observations: fetches and captures of the live source deck. The latest one is the
 * deck's "working tree" that is compared against HEAD. Superseded observations are
 * pruned once nothing may still commit them ({@link ObservationRepository.pruneForDeck}).
 */
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';

import type { IngestWarning, SourceDeckMetadata } from '@/core/model';
import type { IngestMethod } from '@/integrations/deck-source';
import { observations } from '@/server/db/schema';

import { decodeIngestMethod, decodeSourceMetadata, decodeWarnings, encodeJson } from './codec';
import { referencing, withTransaction, type RepositoryContext } from './context';
import { deleteUnreferencedRawBlobs } from './raw-blobs';
import { deleteUnreferencedSnapshots } from './snapshots';

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

export interface ObservationRepository {
  /**
   * Records an observation. The snapshot and raw blob must already be stored.
   * @returns the stored record with its generated id.
   * @throws {RepositoryError} `not-found` when the deck, snapshot or raw blob is unknown.
   */
  insert(input: NewObservation): ObservationRecord;
  getById(id: string): ObservationRecord | null;
  /** The deck's working state: latest `fetchedAt`, ties broken by insertion order. */
  latestForDeck(deckId: string): ObservationRecord | null;
  /**
   * Deletes the deck's observations except `keepIds`, then the snapshots and raw blobs
   * that no commit or remaining observation references any more (their card index rows
   * cascade). Atomic; inside a transaction it joins it.
   * @returns the number of observations deleted.
   */
  pruneForDeck(deckId: string, keepIds: readonly string[]): number;
}

export function createObservationRepository(ctx: RepositoryContext): ObservationRepository {
  return {
    insert(input) {
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
      referencing('Observation', () => ctx.db.insert(observations).values(values).run());
      return record;
    },

    getById(id) {
      const row = ctx.db.select().from(observations).where(eq(observations.id, id)).get();
      return row ? toObservationRecord(row) : null;
    },

    latestForDeck(deckId) {
      const row = ctx.db
        .select()
        .from(observations)
        .where(eq(observations.deckId, deckId))
        .orderBy(...latestObservationFirst)
        .limit(1)
        .get();
      return row ? toObservationRecord(row) : null;
    },

    pruneForDeck(deckId, keepIds) {
      return withTransaction(ctx, ({ db }) => {
        const superseded = and(
          eq(observations.deckId, deckId),
          keepIds.length === 0 ? undefined : notInArray(observations.id, [...keepIds]),
        );
        const references = db
          .select({ snapshotHash: observations.snapshotHash, rawBlobHash: observations.rawBlobHash })
          .from(observations)
          .where(superseded)
          .all();
        if (references.length === 0) return 0;
        const deleted = db.delete(observations).where(superseded).run().changes;
        deleteUnreferencedSnapshots(
          db,
          references.map((reference) => reference.snapshotHash),
        );
        deleteUnreferencedRawBlobs(
          db,
          references.map((reference) => reference.rawBlobHash),
        );
        return deleted;
      });
    },
  };
}

/**
 * Ordering that puts a deck's working state first: latest `fetchedAt`, ties broken by
 * insertion order (`rowid`).
 */
export const latestObservationFirst = [desc(observations.fetchedAt), desc(sql`${observations}.rowid`)];

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
