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

/** A compare side from the committed history: a version or the empty deck, never the working state. */
export type CommittedCompareSideDTO = Exclude<CompareSideDTO, { kind: 'working' }>;

// ---------------------------------------------------------------------------
// Share links (ADR 0007)
// ---------------------------------------------------------------------------

/** A share link as listed to the deck's owner. Its token is never stored, so it never appears again. */
export interface ShareLinkDTO {
  id: string;
  deckId: string;
  /** The owner's name for the link ("For Mikko"). */
  label: string;
  /** Whether viewers see the owner's private version notes. */
  includeNotes: boolean;
  createdAt: string;
  /** Last view through the link (recorded at most hourly); `null` before the first view. */
  lastViewedAt: string | null;
}

/**
 * A new share link. `url` contains the link's token: show it once, to the owner who
 * created the link, and never log or store it. It cannot be shown again; a lost link is
 * revoked and replaced.
 */
export interface CreatedShareLinkDTO {
  link: ShareLinkDTO;
  url: string;
}

/** What a share link grants, for the viewer pages (banner, notes). */
export interface ShareInfoDTO {
  /**
   * The owner's name for the link ("For Mikko"). Written by the owner for themselves;
   * shown to viewers only if the page chooses to.
   */
  label: string;
  /** Whether version pages include the owner's notes. */
  includeNotes: boolean;
  /** Display name of the deck's owner. */
  ownerDisplayName: string;
  /** The shared deck. Not a secret, and never needed to reach it: the token decides. */
  deckId: string;
}

/**
 * A shared deck as viewers see it: committed facts only. Name, format and commanders
 * come from the latest version (HEAD), never from the latest Moxfield state, and there
 * is no status, working state or fetch error. Every field is a field of
 * {@link DeckSummaryDTO}, so components can take either.
 *
 * Nothing says where the deck lives on Moxfield (no `url`, no `externalId`): its URL
 * opens the live deck, uncommitted changes included, and for an unlisted deck it is the
 * only key to it. Unlike the share link, it could not be taken back.
 */
export interface SharedDeckDTO {
  id: string;
  source: string;
  /**
   * The latest version's deck name; `''` before the first version, or when that version
   * has no name. Show it with `sharedDeckTitle`.
   */
  name: string;
  /** The latest version's format; `''` before the first version. */
  format: string;
  /** The latest version's commanders. */
  commanders: string[];
  head: VersionRefDTO | null;
  versionCount: number;
}

/** A shared deck's overview: the deck and its newest versions. */
export interface SharedOverviewDTO extends SharedDeckDTO {
  /** The newest versions, newest first (at most `RECENT_VERSION_COUNT`). */
  recentVersions: VersionListItemDTO[];
}

/**
 * A version as viewers see it: `notes` is empty unless the link includes notes. Without
 * the source metadata, which names the deck on Moxfield (id, URL) and its authors there.
 */
export interface SharedVersionDetailDTO extends Omit<VersionDetailDTO, 'deck' | 'sourceMetadata'> {
  deck: SharedDeckDTO;
}

/** A comparison of two committed states (versions or the empty deck). */
export interface SharedCompareDTO extends Omit<CompareDTO, 'deck' | 'from' | 'to' | 'hasWorking'> {
  deck: SharedDeckDTO;
  from: CommittedCompareSideDTO;
  to: CommittedCompareSideDTO;
  /** Viewers never see the working state. */
  hasWorking: false;
}

/** A card's history over the committed versions (never a working-state point). */
export interface SharedCardHistoryDTO extends Omit<CardHistoryDTO, 'deck'> {
  deck: SharedDeckDTO;
}

/** The restore export of a version, for viewers. */
export interface SharedRestoreDTO extends Omit<RestoreDTO, 'deck'> {
  deck: SharedDeckDTO;
}
