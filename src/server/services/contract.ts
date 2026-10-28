/**
 * The application service API consumed by the UI layer (server components, server
 * actions, route handlers). The UI depends only on these interfaces and the DTOs in
 * `./types`, so it can be tested against fakes and the implementation can evolve.
 *
 * - {@link DeckServices}: the owner scope (ADR 0007), bound to one workspace. The UI
 *   obtains it with `servicesFor(user)` from `@/server/access`. Every deck id is resolved
 *   within that workspace; a deck of another workspace behaves exactly like a deck that
 *   does not exist (`null`, `[]` or a `not-found` error, never `forbidden`), so ids do not
 *   reveal whether something exists.
 * - {@link ShareLinkServices}: the owner's share links, bound to the workspace and the
 *   asking session (`shareLinkServicesFor(user)`).
 * - {@link SharedDeckServices}: the viewer scope, bound to the one deck a share link
 *   grants (`sharedDeckServices(token)`); read-only by type.
 */
import type { CapturedIngestMethod, ServerFetchStatus } from '@/integrations/deck-source';

import type {
  CaptureOutcome,
  CardHistoryDTO,
  CardSearchResultDTO,
  CommitNoteDTO,
  CommitOutcome,
  CompareDTO,
  CreatedShareLinkDTO,
  DeckOverviewDTO,
  DeckSummaryDTO,
  FetchOutcome,
  RestoreDTO,
  ShareInfoDTO,
  SharedCardHistoryDTO,
  SharedCompareDTO,
  SharedOverviewDTO,
  SharedRestoreDTO,
  SharedVersionDetailDTO,
  ShareLinkDTO,
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

export type TagOutcome = { ok: true; tags: string[] } | { ok: false; message: string };

export type RelinkDeckOutcome =
  | {
      ok: true;
      /** The Moxfield deck the deck follows now, and its URL. */
      externalId: string;
      url: string;
      /** Result of the fetch of the new Moxfield deck, or null when server fetch is unavailable. */
      fetch: FetchOutcome | null;
    }
  | {
      ok: false;
      reason:
        /** The input is not a Moxfield deck URL or id. */
        | 'invalid-ref'
        /** The deck already follows that Moxfield deck. */
        | 'unchanged'
        /** Another deck of the workspace tracks that Moxfield deck. */
        | 'already-tracked';
      /** User-facing; for `already-tracked` it says how to proceed. */
      message: string;
      /** For `already-tracked`: the workspace's deck that tracks it. */
      trackedBy?: { deckId: string; name: string; versionCount: number };
    };

/** Where Moxfield is and who may hand captures over: no secrets, no database reads. */
export interface MoxfieldOriginsDTO {
  /** Origins allowed to hand captured decks to /capture. */
  captureAllowedOrigins: string[];
  moxfieldSiteOrigin: string;
  moxfieldApiBaseUrl: string;
}

export interface SetupInfoDTO extends MoxfieldOriginsDTO {
  serverFetch: ServerFetchStatus;
  /** Whether a Moxfield-issued User-Agent is configured (value never exposed). */
  userAgentConfigured: boolean;
  /** Why the configured User-Agent should not be used here (see `moxfieldUserAgentWarning`), or `null`. */
  userAgentWarning: string | null;
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

/** A deck handed over by the user's browser or pasted (see {@link DeckServices.ingestCapture}). */
export interface IngestCaptureInput {
  data: unknown;
  method: CapturedIngestMethod;
  track: boolean;
  relinkDeckId?: string;
}

/** A version to commit (see {@link DeckServices.commit}). */
export interface CommitInput {
  /** The subject: one line (line breaks become spaces). */
  message: string;
  /** More about the change, kept after the subject as a Git commit body; optional. */
  description?: string;
  /** The observation the user reviewed. */
  expectedObservationId: string;
  /** HEAD the user saw (null when committing the first version). */
  expectedHeadCommitId: string | null;
  tags?: string[];
}

export interface DeckServices {
  /** The workspace's decks. */
  listDecks(): Promise<DeckSummaryDTO[]>;
  /**
   * Parses a Moxfield URL/id, creates the deck in the workspace (idempotent) and tries an
   * initial server fetch. Other workspaces tracking the same Moxfield deck do not matter:
   * every workspace has its own deck and history.
   */
  trackDeck(input: string): Promise<TrackDeckOutcome>;
  /** Deletes a deck and its entire history. */
  untrackDeck(deckId: string): Promise<void>;
  /**
   * Points a deck at another Moxfield deck ("Change Moxfield deck"): for a deck the user
   * deleted on Moxfield and made again, which gives it a new public id. `input` is a
   * Moxfield deck URL or public id. The deck keeps its id, name and every version (their
   * commit ids stay valid: a commit object's `deck` header records the deck reference at
   * commit time); new versions are committed under the new reference. Its working state
   * (the last fetch or capture of the old Moxfield deck) is dropped, and the change is
   * recorded (see {@link DeckOverviewDTO.relinks}). Then, when server fetch is available,
   * the new Moxfield deck is fetched, as when tracking a deck.
   *
   * Refuses a Moxfield deck another deck of the workspace tracks (`already-tracked`, with
   * how to proceed: stop tracking that deck first).
   * @throws {ServiceError} `not-found` for a deck that is not the workspace's.
   */
  relinkDeck(deckId: string, input: string): Promise<RelinkDeckOutcome>;

  getOverview(deckId: string): Promise<DeckOverviewDTO | null>;
  /**
   * Server-side fetch of the current Moxfield state, when the user asks for it. Respects the
   * per-deck cooldown and the installation-wide request limiter (ADR 0009).
   */
  refresh(deckId: string): Promise<FetchOutcome>;
  /**
   * Ingests a deck handed over by the user's browser (bookmarklet) or pasted manually,
   * into the workspace. `data` is untrusted.
   *
   * - With `track: false`, a deck the workspace does not track yet yields
   *   `status: 'untracked'`, with the workspace's decks it could continue instead.
   * - With `relinkDeckId` ("Continue an existing deck's history"), the captured deck
   *   becomes the working state of that deck of the workspace, which is first pointed at
   *   the captured Moxfield deck as {@link relinkDeck} does (both in one transaction);
   *   `track` is then irrelevant. Refused with a `ServiceError` (`invalid-input`) when
   *   another deck of the workspace tracks the captured Moxfield deck, and (`not-found`)
   *   when `relinkDeckId` is not a deck of the workspace.
   */
  ingestCapture(input: IngestCaptureInput): Promise<CaptureOutcome>;

  commit(deckId: string, input: CommitInput): Promise<CommitOutcome>;

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

  /**
   * Configuration facts for the setup page. Holds no secrets. (Pages without a signed-in
   * user use `getSetupInfo()` from `@/server/access`.)
   */
  getSetupInfo(): Promise<SetupInfoDTO>;
}

/** A share link to create (see {@link ShareLinkServices.createShareLink}). */
export interface ShareLinkInput {
  /** The owner's name for the link. */
  label: string;
  /** Whether viewers see the owner's version notes. */
  includeNotes: boolean;
}

/**
 * The owner's read-only share links of their decks (ADR 0007), bound to the signed-in
 * user's workspace and the session asking (a link records the bookmarklet key that
 * session descends from, so revoking a stolen key can revoke the links made with it).
 * A deck or link of another workspace behaves like one that does not exist.
 */
export interface ShareLinkServices {
  /**
   * Creates a read-only link to one of the workspace's decks, for git-moxfield at `appUrl`
   * (its public base URL). The link's token exists in plaintext only inside the returned
   * `url`: show it once, to the owner, and never log or store it.
   * @throws {ServiceError} `invalid-input` for an invalid label (1–60 characters; see
   * `MAX_SHARE_LINK_LABEL_LENGTH`) or a non-boolean `includeNotes`; `not-found` for a deck
   * that is not the workspace's; `forbidden` when the asking session has ended meanwhile.
   * @throws {TypeError} when `appUrl` is not an absolute http(s) URL (nothing is stored).
   */
  createShareLink(deckId: string, input: ShareLinkInput, appUrl: string): Promise<CreatedShareLinkDTO>;
  /** The deck's links that are not revoked, newest first; `[]` for a deck that is not the workspace's. */
  listShareLinks(deckId: string): Promise<ShareLinkDTO[]>;
  /**
   * Revokes one of the deck's links: viewing through it ends at once. Idempotent.
   * @returns whether a link was revoked (`false` when it was already revoked or is unknown).
   */
  revokeShareLink(deckId: string, linkId: string): Promise<boolean>;
}

/**
 * The viewer scope (ADR 0007): one deck's committed history, read-only, for anyone
 * holding a share link (signed in or not).
 *
 * - **Read-only by type:** there are no write methods (no refresh, commit, tags, notes or
 *   untrack), so a viewer page cannot call one by mistake.
 * - **One deck:** every method reads the link's deck; no method takes a deck id, so
 *   nothing from the client can name another deck. Commit id prefixes and card names
 *   resolve within the deck only.
 * - **Committed history only:** no uncommitted Moxfield state, status or fetch errors
 *   anywhere; the deck's name, format and commanders come from its latest version;
 *   `compare` refuses `working`; card history never has a working-state point.
 * - **Notes** (private annotations on versions) only when the link includes them.
 * - **Revocation is immediate:** once the link is revoked, the deck untracked or its owner
 *   disabled, every method answers as for a missing deck (`null`, `[]`), also on an
 *   instance obtained before.
 */
export interface SharedDeckServices {
  /**
   * Whether the link still grants access (not revoked, deck tracked, owner enabled):
   * once it does not, every other method answers as for a missing deck. Tells a link that
   * stopped working from a version or card the deck does not have.
   */
  isAvailable(): Promise<boolean>;
  /** The deck (committed facts) and its newest versions, or `null`. */
  getOverview(): Promise<SharedOverviewDTO | null>;
  /** Every version, newest first; with `tag`, only those carrying it. */
  listVersions(options?: { tag?: string }): Promise<VersionListItemDTO[]>;
  /** One version (`notes` empty unless the link includes notes), or `null`. */
  getVersion(sequence: number): Promise<SharedVersionDetailDTO | null>;
  /**
   * Compares two committed states. References as {@link VersionRef}, except `working`,
   * which (like any unknown reference) gives `null`.
   */
  compare(from: VersionRef, to: VersionRef): Promise<SharedCompareDTO | null>;
  /** Cards of the deck's versions matching `query` (never cards only in the working state). */
  searchCards(query: string, limit?: number): Promise<CardSearchResultDTO[]>;
  /** `card` is a card key or name. The history covers committed versions only. */
  cardHistory(card: string): Promise<SharedCardHistoryDTO | null>;
  /** Paste-ready restore text of a version, or `null`. */
  restoreExport(sequence: number): Promise<SharedRestoreDTO | null>;
  /** Every tag used in the deck's versions, with counts. */
  listTags(): Promise<TagCountDTO[]>;
}

/** What `sharedDeckServices(token)` grants: the viewer services and what the link is. */
export interface SharedDeckAccess {
  services: SharedDeckServices;
  share: ShareInfoDTO;
}
