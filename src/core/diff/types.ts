/**
 * Semantic deck diff types.
 *
 * A diff compares two {@link CanonicalSnapshot}s. Card movement between zones is
 * detected *before* anything is classified as an addition or removal, so
 * "Dress Down: mainboard → considering" is a single `moved` change rather than an
 * unrelated remove/add pair.
 *
 * Strategic identity is the card key (oracle name). Printing changes are reported
 * separately as cosmetic `printing` changes.
 */
import type { CanonicalPrinting, CardKey } from '../model';
import type { ZoneId } from '../zones';

interface CardRef {
  key: CardKey;
  /** Display name (taken from the newer snapshot when both exist). */
  name: string;
}

/** Copies moved from one zone to another. */
export interface MovedChange extends CardRef {
  type: 'moved';
  from: ZoneId;
  to: ZoneId;
  quantity: number;
}

/** Card newly present in a zone (not explained by a move). */
export interface AddedChange extends CardRef {
  type: 'added';
  zone: ZoneId;
  quantity: number;
}

/** Card no longer present in a zone (not explained by a move). */
export interface RemovedChange extends CardRef {
  type: 'removed';
  zone: ZoneId;
  quantity: number;
}

/**
 * Quantity change in a zone that still contains the card afterwards and either
 * contained it before or received copies via a move. `from` is the quantity after
 * moves were applied, `to` the final quantity.
 */
export interface QuantityChange extends CardRef {
  type: 'quantity';
  zone: ZoneId;
  from: number;
  to: number;
}

/** Same card, same zone, different printing(s). Cosmetic, not strategic. */
export interface PrintingChange extends CardRef {
  type: 'printing';
  zone: ZoneId;
  before: CanonicalPrinting[];
  after: CanonicalPrinting[];
}

/** Per-card user tags changed. Cosmetic, not strategic. */
export interface CardTagsChange extends CardRef {
  type: 'tags';
  added: string[];
  removed: string[];
}

/** The same oracle card is reported under a different name (detected via stable source ids). */
export interface RenamedChange extends CardRef {
  type: 'renamed';
  previousName: string;
}

export type CardChange =
  | MovedChange
  | AddedChange
  | RemovedChange
  | QuantityChange
  | PrintingChange
  | CardTagsChange
  | RenamedChange;

export type CardChangeType = CardChange['type'];

/** Change types that alter what is in which zone. */
export const STRATEGIC_CHANGE_TYPES: ReadonlySet<CardChangeType> = new Set([
  'moved',
  'added',
  'removed',
  'quantity',
]);

export type DeckInfoChange =
  | { field: 'name' | 'format' | 'description'; before: string; after: string }
  /** `added` and `removed` are sorted (ordinal, like card tags); `before` and `after` keep the deck's own order. */
  | { field: 'tags'; before: string[]; after: string[]; added: string[]; removed: string[] };

export type PrimerChange =
  | { status: 'unchanged' }
  /** Line counts from a line-based diff. */
  | { status: 'changed'; addedLines: number; removedLines: number }
  /**
   * The before side has no captured primer (`null`) and the after side has a non-empty
   * one. A change: committing it records the primer.
   */
  | { status: 'captured' }
  /**
   * No claim about changes is made: the after side has no captured primer (`null`; a
   * failed primer fetch is never a deletion), or neither side has primer text.
   */
  | { status: 'unknown' };

/** Whether the primer counts as a difference: its text changed, or it was captured for the first time. */
export function primerHasChange(primer: PrimerChange | undefined): boolean {
  return primer?.status === 'changed' || primer?.status === 'captured';
}

export interface ZoneDiffStats {
  zone: ZoneId;
  /** Copies added to this zone, excluding moves (additions + quantity increases). */
  added: number;
  /** Copies removed from this zone, excluding moves (removals + quantity decreases). */
  removed: number;
  /** Copies moved into this zone from other zones. */
  movedIn: number;
  /** Copies moved out of this zone into other zones. */
  movedOut: number;
}

export interface MoveStats {
  from: ZoneId;
  to: ZoneId;
  /** Total copies moved along this edge. */
  quantity: number;
  /** Distinct cards moved along this edge. */
  cards: number;
}

export interface DiffStats {
  /** Only zones with at least one non-zero counter, in canonical zone order. */
  zones: ZoneDiffStats[];
  /** Aggregated moves per (from, to) pair, in canonical zone order of `from`, then `to`. */
  moves: MoveStats[];
  printingChanges: number;
  tagChanges: number;
  /** Cards that are the same card under a new name (`renamed` changes). */
  renames: number;
}

export interface CommanderSummary {
  /** Commander names before, sorted by key. */
  before: string[];
  /** Commander names after, sorted by key. */
  after: string[];
  /**
   * True when any move/add/remove/quantity change touches the commanders zone.
   * Printing changes and renames of a commander do not count.
   */
  changed: boolean;
}

export interface DeckDiff {
  /**
   * All card-level changes in deterministic order: by type
   * (moved, added, removed, quantity, printing, tags, renamed), then by the zone
   * (`from`, then `to` for moves) in canonical zone order, then by card key.
   */
  changes: CardChange[];
  deck: DeckInfoChange[];
  primer: PrimerChange;
  commanders: CommanderSummary;
  stats: DiffStats;
  /** True when nothing at all differs (cards, printings, tags, deck info, primer). */
  isEmpty: boolean;
  /** True when any moved/added/removed/quantity change exists. */
  hasCardChanges: boolean;
  /** True when every difference is cosmetic (printing, card tags, renames). */
  onlyCosmetic: boolean;
}
