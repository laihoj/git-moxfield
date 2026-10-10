/**
 * Card-level history types. Card history is *derived* from the commit history; nothing
 * is stored per card beyond the snapshots themselves.
 */
import type { CardKey } from '../model';
import type { ZoneId } from '../zones';

export interface ZoneQuantity {
  zone: ZoneId;
  quantity: number;
}

/** The state of one card at one version. `zones` is empty when the card is absent. */
export interface CardVersionPoint {
  /** Commit id, or `null` for the uncommitted working state. */
  commitId: string | null;
  /** Version number (`v12` → 12), or `null` for the uncommitted working state. */
  sequence: number | null;
  /** ISO timestamp of the commit (or of the fetch, for the working state). */
  at: string;
  message: string;
  /** Zones containing the card, in canonical zone order, quantities > 0. */
  zones: ZoneQuantity[];
  /**
   * Set when the card was renamed since the previous point (a rename the semantic diff
   * reconciles, e.g. an oracle name change): its key and display name at that point.
   * A rename is cosmetic: it never makes the card count as removed or added.
   */
  renamedFrom?: { key: CardKey; name: string };
}

export type CardTransition =
  /** First version in the examined range that contains the card. */
  | 'first-seen'
  /** Card entered the deck (any zone) without having been in it before. */
  | 'added'
  /** Card left every zone. */
  | 'removed'
  /**
   * The card's zone set changed while it stayed in the deck, without returning to a
   * zone it had occupied before (includes partially leaving or gaining a zone).
   */
  | 'moved'
  /** Card returned to a zone it had occupied earlier and then left. */
  | 'restored'
  /** Same zones, different quantities. */
  | 'quantity'
  /** No change relative to the previous version. */
  | 'unchanged';

export interface CardHistoryEntry extends CardVersionPoint {
  transition: CardTransition;
  /** Zones before this version (the previous point's zones). */
  previousZones: ZoneQuantity[];
  /**
   * Present exactly when `transition === 'restored'`: the zone(s) the card returned to,
   * with the sequence of the last version in which it had been there before leaving.
   * Empty when the card re-entered the deck in a zone it never occupied before
   * (UI wording: "Returned to the deck").
   */
  restoredFrom?: { zone: ZoneId; lastSequence: number | null }[];
}

/**
 * A run of consecutive versions where the card's state did not change. A rename starts
 * a new run, so its first entry can show it.
 */
export interface CardHistoryRun {
  zones: ZoneQuantity[];
  /** First and last entry of the run (same entry when the run has length 1). */
  first: CardHistoryEntry;
  last: CardHistoryEntry;
  length: number;
}

export interface CardHistory {
  /** The card's key at the newest examined point (history follows renames). */
  key: CardKey;
  /** Most recent known display name. */
  name: string;
  /** One entry per examined version, oldest first. */
  entries: CardHistoryEntry[];
  /** Entries whose transition is not `unchanged` or that rename the card, oldest first. */
  changes: CardHistoryEntry[];
  /** Consecutive identical states compressed, oldest first. */
  runs: CardHistoryRun[];
  summary: {
    /** First version containing the card, or null if it never appears. */
    firstSeenSequence: number | null;
    /** Last committed version containing the card. */
    lastSeenSequence: number | null;
    /** Zones in the newest examined point. */
    currentZones: ZoneQuantity[];
    /** Number of versions (among examined) containing the card in a played zone. */
    versionsInPlayedZones: number;
    /** Number of times the card left the played zones (cut to considering/sideboard or removed). */
    timesCut: number;
    /**
     * Number of `restored` transitions that are not also cuts (a return to a non-played
     * zone that takes the card out of play counts only as a cut).
     */
    timesRestored: number;
  };
}
