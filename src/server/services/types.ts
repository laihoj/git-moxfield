/**
 * Data transfer objects returned by the service layer to the UI (server components,
 * server actions, route handlers). Plain serializable data only.
 */
import type { DeckDiff, DiffStats, PrimerChange } from '@/core/diff/types';
import type { CardHistory, ZoneQuantity } from '@/core/history/types';
import type { CanonicalSnapshot, CardFacts, CardKey, IngestWarning, SourceDeckMetadata } from '@/core/model';
import type { PrimerDiff } from '@/core/primer/types';
import type {
  DeckSourceErrorCode,
  IngestMethod,
  RestoreExport,
  ServerFetchStatus,
} from '@/integrations/deck-source';

export type DeckStatus =
  /** Tracked, but Moxfield state has never been fetched/captured. */
  | 'never-fetched'
  /** Moxfield state known, but no version committed yet. */
  | 'no-versions'
  /** Current Moxfield state has card/deck/primer changes since the latest version. */
  | 'uncommitted'
  /** Only printing / card-tag / rename differences since the latest version. */
  | 'cosmetic-only'
  /** Current Moxfield state matches the latest version. */
  | 'clean';

export interface FetchErrorDTO {
  code: DeckSourceErrorCode;
  message: string;
  at: string;
  retryAfterSeconds: number | null;
}

export interface VersionRefDTO {
  commitId: string;
  shortId: string;
  sequence: number;
  message: string;
  createdAt: string;
  sourceVersion: number | null;
  sourceUpdatedAt: string | null;
}

export interface ObservationDTO {
  id: string;
  fetchedAt: string;
  method: IngestMethod;
  sourceVersion: number | null;
  sourceUpdatedAt: string | null;
  snapshotHash: string;
}

export interface DeckSummaryDTO {
  id: string;
  source: string;
  externalId: string;
  url: string;
  name: string;
  format: string;
  commanders: string[];
  status: DeckStatus;
  head: VersionRefDTO | null;
  working: ObservationDTO | null;
  lastFetchError: FetchErrorDTO | null;
  /** Diff stats HEAD → working, when both exist. */
  workingStats: DiffStats | null;
  versionCount: number;
}

export interface VersionListItemDTO extends VersionRefDTO {
  parentSequence: number | null;
  tags: string[];
  /** Stats relative to the parent version (or empty deck for the first version). */
  stats: DiffStats;
  primer: PrimerChange;
  commanders: string[];
  /** Copies in played zones (commanders, companions, signature spells, mainboard). */
  playedCardCount: number;
  ingestMethod: IngestMethod;
}

export interface DeckOverviewDTO extends DeckSummaryDTO {
  /** HEAD → working diff (HEAD missing ⇒ diff from the empty deck). Null without a working state. */
  diff: DeckDiff | null;
  warnings: IngestWarning[];
  recentVersions: VersionListItemDTO[];
  serverFetch: ServerFetchStatus;
  /** Card facts for every card key referenced by `diff`. */
  catalog: Record<CardKey, CardFacts>;
  /** True when the client should trigger a background refresh on load. */
  autoRefreshSuggested: boolean;
  /** Suggested commit message derived from the diff. */
  suggestedMessage: string;
}

export interface CommitNoteDTO {
  id: string;
  kind: string;
  data: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface VersionDetailDTO {
  deck: DeckSummaryDTO;
  version: VersionListItemDTO;
  snapshot: CanonicalSnapshot;
  sourceMetadata: SourceDeckMetadata;
  /** Diff relative to the parent (or empty deck). */
  diff: DeckDiff;
  primerDiff: PrimerDiff;
  notes: CommitNoteDTO[];
  catalog: Record<CardKey, CardFacts>;
  previous: VersionRefDTO | null;
  next: VersionRefDTO | null;
}

export type CompareSideDTO =
  | { kind: 'version'; version: VersionRefDTO }
  | { kind: 'working'; observation: ObservationDTO }
  | { kind: 'empty' };

export interface CompareDTO {
  deck: DeckSummaryDTO;
  from: CompareSideDTO;
  to: CompareSideDTO;
  diff: DeckDiff;
  primerDiff: PrimerDiff;
  /**
   * Each side's primer source (the source's own markup), so a primer can be copied back
   * to Moxfield: `''` for no primer (or the empty deck), `null` when not captured.
   */
  primers: { from: string | null; to: string | null };
  catalog: Record<CardKey, CardFacts>;
  /** All versions, newest first, for the pickers. */
  versions: VersionRefDTO[];
  hasWorking: boolean;
}

export interface CardHistoryDTO {
  deck: DeckSummaryDTO;
  history: CardHistory;
  facts: CardFacts | null;
}

export interface CardSearchResultDTO {
  key: CardKey;
  name: string;
  /** Zones in the latest version (empty when not in the latest version). */
  headZones: ZoneQuantity[];
  /** Number of versions containing the card in any zone. */
  versionsPresent: number;
  lastSeenSequence: number | null;
  /** Card reference data for display (mana cost, type line), when known. */
  facts: CardFacts | null;
}

export interface RestoreDTO {
  deck: DeckSummaryDTO;
  version: VersionRefDTO;
  export: RestoreExport;
}

export type FetchOutcome =
  | { ok: true; observationId: string; changedSinceLastObservation: boolean }
  | { ok: false; error: FetchErrorDTO };

export type CaptureOutcome =
  | { status: 'ingested'; deckId: string; changedSinceLastObservation: boolean }
  | { status: 'untracked'; source: string; externalId: string; name: string };

export type CommitOutcome =
  | { ok: true; version: VersionRefDTO }
  | {
      ok: false;
      reason:
        /** Moxfield changed since the reviewed state; review again. */
        | 'stale'
        /** Another commit landed first. */
        | 'head-moved'
        /** No differences relative to the latest version. */
        | 'nothing-to-commit'
        /** No Moxfield state has been fetched/captured yet. */
        | 'no-working-state'
        | 'invalid-message';
      message: string;
    };

export interface TagCountDTO {
  name: string;
  count: number;
}
