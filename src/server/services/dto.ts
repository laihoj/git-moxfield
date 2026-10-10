/**
 * Mapping from repository records and core values to the plain, serializable DTOs of
 * `./types`. Pure helpers; no I/O.
 */
import { commanderNames, playedCardCount } from '@/core/canonical';
import type { DeckDiff } from '@/core/diff/types';
import { shortId } from '@/core/hash';
import type { ZoneQuantity } from '@/core/history/types';
import type { CanonicalSnapshot, CardFacts, CardKey } from '@/core/model';
import type { ZoneId } from '@/core/zones';
import type {
  CommitNoteRecord,
  CommitRecord,
  FetchErrorRecord,
  ObservationRecord,
} from '@/server/repositories';

import type {
  CommitNoteDTO,
  DeckStatus,
  FetchErrorDTO,
  ObservationDTO,
  VersionListItemDTO,
  VersionRefDTO,
} from './types';

export function toVersionRefDTO(commit: CommitRecord): VersionRefDTO {
  return {
    commitId: commit.id,
    shortId: shortId(commit.id),
    sequence: commit.sequence,
    message: commit.message,
    createdAt: commit.createdAt,
    sourceVersion: commit.sourceVersion,
    sourceUpdatedAt: commit.sourceUpdatedAt,
  };
}

/**
 * A version list item. `diff` must be the diff from the parent version (or from the
 * empty deck for a first version) to `snapshot`.
 */
export function toVersionListItemDTO(input: {
  commit: CommitRecord;
  parent: CommitRecord | null;
  snapshot: CanonicalSnapshot;
  diff: DeckDiff;
  tags: string[];
}): VersionListItemDTO {
  const { commit, parent, snapshot, diff, tags } = input;
  return {
    ...toVersionRefDTO(commit),
    parentSequence: parent?.sequence ?? null,
    tags: [...tags],
    stats: diff.stats,
    primer: diff.primer,
    commanders: commanderNames(snapshot),
    playedCardCount: playedCardCount(snapshot),
    ingestMethod: commit.ingestMethod,
  };
}

export function toObservationDTO(observation: ObservationRecord): ObservationDTO {
  return {
    id: observation.id,
    fetchedAt: observation.fetchedAt,
    method: observation.ingestMethod,
    sourceVersion: observation.sourceVersion,
    sourceUpdatedAt: observation.sourceUpdatedAt,
    snapshotHash: observation.snapshotHash,
  };
}

export function toFetchErrorDTO(error: FetchErrorRecord): FetchErrorDTO {
  return {
    code: error.code,
    message: error.message,
    at: error.at,
    retryAfterSeconds: error.retryAfterSeconds,
  };
}

export function toCommitNoteDTO(note: CommitNoteRecord): CommitNoteDTO {
  return {
    id: note.id,
    kind: note.kind,
    data: note.data,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

/** Card facts as a plain record (maps do not cross the server/client boundary). */
export function toCatalogRecord(facts: ReadonlyMap<CardKey, CardFacts>): Record<CardKey, CardFacts> {
  return Object.fromEntries(facts);
}

/** Every card key a diff refers to, in change order, without duplicates. */
export function diffCardKeys(diff: DeckDiff): CardKey[] {
  return [...new Set(diff.changes.map((change) => change.key))];
}

/** One card's entry of `cardZoneIndex` as a zone list (canonical zone order; empty when absent). */
export function zoneQuantities(zones: ReadonlyMap<ZoneId, number> | undefined): ZoneQuantity[] {
  return zones ? [...zones].map(([zone, quantity]) => ({ zone, quantity })) : [];
}

/**
 * Deck status from the latest version, the latest observation and the diff between
 * them (HEAD, or the empty deck, → working state).
 */
export function deckStatus(hasHead: boolean, diff: DeckDiff | null): DeckStatus {
  if (diff === null) return 'never-fetched';
  if (!hasHead) return 'no-versions';
  if (diff.isEmpty) return 'clean';
  return diff.onlyCosmetic ? 'cosmetic-only' : 'uncommitted';
}
