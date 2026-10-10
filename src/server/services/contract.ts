/**
 * The application service API consumed by the UI layer (server components, server
 * actions, route handlers). The UI depends only on this interface and the DTOs in
 * `./types`, so it can be tested against fakes and the implementation can evolve.
 */
import type { IngestMethod, ServerFetchStatus } from '@/integrations/deck-source';

import type {
  CaptureOutcome,
  CardHistoryDTO,
  CardSearchResultDTO,
  CommitNoteDTO,
  CommitOutcome,
  CompareDTO,
  DeckOverviewDTO,
  DeckSummaryDTO,
  FetchOutcome,
  RestoreDTO,
  TagCountDTO,
  VersionDetailDTO,
  VersionListItemDTO,
} from './types';

export type TrackDeckOutcome =
  | {
      ok: true;
      deckId: string;
      /** True when the deck was already tracked (no new deck created). */
      alreadyTracked: boolean;
      /** Result of the initial server fetch, or null when server fetch is unavailable. */
      fetch: FetchOutcome | null;
    }
  | { ok: false; reason: string };

export type TagOutcome = { ok: true; tags: string[] } | { ok: false; reason: string };

export interface SetupInfoDTO {
  serverFetch: ServerFetchStatus;
  /** Whether a Moxfield-issued User-Agent is configured (value never exposed). */
  userAgentConfigured: boolean;
  /** Origins allowed to hand captured decks to /capture. */
  captureAllowedOrigins: string[];
  moxfieldSiteOrigin: string;
  moxfieldApiBaseUrl: string;
}

/** The "Send to git-moxfield" bookmarklets as `javascript:` URLs. */
export interface BookmarkletsDTO {
  /** Desktop browsers: opens git-moxfield in a popup and hands the deck over by `postMessage`. */
  popup: string;
  /**
   * Phones and in-app browsers: posts the deck to git-moxfield in the same tab. Carries
   * this installation's capture token, so it is a credential: show it only to the user
   * installing it, and never log it.
   */
  sameTab: string;
}

/**
 * Version references accepted by `compare`:
 *   `v12` or `12`  version by sequence
 *   `head`         latest version
 *   `working`      latest observed Moxfield state (uncommitted)
 *   `empty`        the empty deck
 *   4+ hex chars   commit id prefix (unique within the deck)
 */
export type VersionRef = string;

export interface DeckServices {
  listDecks(): Promise<DeckSummaryDTO[]>;
  /** Parses a Moxfield URL/id, creates the deck (idempotent) and tries an initial server fetch. */
  trackDeck(input: string): Promise<TrackDeckOutcome>;
  /** Deletes a deck and its entire history. */
  untrackDeck(deckId: string): Promise<void>;

  getOverview(deckId: string): Promise<DeckOverviewDTO | null>;
  /** Server-side fetch of the current Moxfield state. Respects cooldowns and block backoff. */
  refresh(deckId: string, trigger: 'manual' | 'auto'): Promise<FetchOutcome>;
  /**
   * Ingests a deck handed over by the user's browser (bookmarklet) or pasted manually.
   * `data` is untrusted. With `track: false`, an untracked deck yields `status: 'untracked'`.
   */
  ingestCapture(input: {
    data: unknown;
    method: Exclude<IngestMethod, 'server'>;
    track: boolean;
  }): Promise<CaptureOutcome>;

  commit(
    deckId: string,
    input: {
      message: string;
      /** The observation the user reviewed. */
      expectedObservationId: string;
      /** HEAD the user saw (null when committing the first version). */
      expectedHeadCommitId: string | null;
      tags?: string[];
    },
  ): Promise<CommitOutcome>;

  listVersions(deckId: string, options?: { tag?: string }): Promise<VersionListItemDTO[]>;
  getVersion(deckId: string, sequence: number): Promise<VersionDetailDTO | null>;
  compare(deckId: string, from: VersionRef, to: VersionRef): Promise<CompareDTO | null>;

  searchCards(deckId: string, query: string, limit?: number): Promise<CardSearchResultDTO[]>;
  /** `card` is a card key or a card name (resolved via `cardKey`). */
  cardHistory(
    deckId: string,
    card: string,
    options?: { includeWorking?: boolean },
  ): Promise<CardHistoryDTO | null>;

  restoreExport(deckId: string, sequence: number): Promise<RestoreDTO | null>;

  addTag(deckId: string, sequence: number, tag: string): Promise<TagOutcome>;
  removeTag(deckId: string, sequence: number, tag: string): Promise<TagOutcome>;
  listTags(deckId: string): Promise<TagCountDTO[]>;
  /** Sets (or clears, with empty text) the free-text note of a version. */
  setNote(deckId: string, sequence: number, text: string): Promise<CommitNoteDTO | null>;

  /** Converts a deck's primer markup to portable markdown via its DeckSource. */
  primerToMarkdown(source: string, primer: string): string;
  /** Configuration facts for the setup page. Holds no secrets. */
  getSetupInfo(): SetupInfoDTO;
  /**
   * The bookmarklets for git-moxfield reachable at `appUrl` (its public base URL), aimed
   * at the configured Moxfield site and API. Creates the capture token on first use.
   * @throws {TypeError} when `appUrl` is not an absolute http(s) URL.
   */
  getBookmarklets(appUrl: string): BookmarkletsDTO;
  /**
   * This installation's capture token: the secret the same-tab bookmarklet posts along
   * with the deck, which authenticates its cross-site form post. Created (atomically) on
   * first use and stable afterwards. Server-only: never send it to a browser other than
   * inside {@link BookmarkletsDTO.sameTab}, and never log it.
   */
  getCaptureToken(): string;
}
