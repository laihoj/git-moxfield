/**
 * Canonical, platform-neutral deck model.
 *
 * This is the representation that semantic diffs, history and hashing operate on.
 * It deliberately contains only *user-controlled deck state*: which cards are in
 * which zone, in what quantity and printing, plus deck-level text. It never contains
 * volatile source data (view counts, prices, timestamps, source version numbers) or
 * card reference data (oracle text, type lines), so two semantically identical deck
 * states always serialize to identical bytes.
 *
 * Nothing in this module knows about Moxfield's HTTP payloads.
 */
import type { ZoneId } from './zones';

/** Version of the canonical snapshot schema. Bump when the shape changes. */
export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

/**
 * Strategic card identity. Derived from the card's English oracle name via
 * {@link import('./card-key').cardKey}. Changing printing never changes the key.
 */
export type CardKey = string;

/** Card finishes. Unknown finishes from a source are preserved verbatim (lowercased). */
export type Finish = 'nonfoil' | 'foil' | 'etched' | (string & {});

/** Stable, source-provided identifiers for a card's *oracle identity* (not printing). */
export interface CardIdentityIds {
  /** Moxfield `card.uniqueCardId` — stable across printings. */
  moxfield?: string;
  /** Scryfall oracle id, when a source exposes it. */
  scryfallOracle?: string;
}

/** Stable identifiers for one specific printing. */
export interface PrintingIds {
  /** Scryfall card (printing) id. */
  scryfall?: string;
  /** Moxfield `card.id` — identifies the printing in Moxfield. */
  moxfield?: string;
}

/** One printing of a card in one zone, with how many copies use that printing. */
export interface CanonicalPrinting {
  /** Set code, lowercase (e.g. `thb`). */
  set: string;
  /** Collector number exactly as the source reports it (e.g. `308`, `1492★`, `OTC-252`). */
  collectorNumber: string;
  finish: Finish;
  /** Language code, lowercase (e.g. `en`). */
  lang: string;
  /** Copies using this exact printing. Integer >= 1. */
  quantity: number;
  /** User-set flags such as `alter` or `proxy`. Sorted, unique. Omitted when empty. */
  flags?: string[];
  ids: PrintingIds;
}

/** A card in a zone. The same {@link CardKey} may appear in several zones. */
export interface CanonicalCard {
  key: CardKey;
  /** Display name, e.g. `Birgi, God of Storytelling // Harnfel, Horn of Bounty`. */
  name: string;
  /** Total copies in this zone. Integer >= 1. Equals the sum of printing quantities when printings are known. */
  quantity: number;
  /**
   * Printings, sorted by (set, collectorNumber, finish, lang, flags). May be empty when
   * the source does not expose printing information; `quantity` is authoritative.
   */
  printings: CanonicalPrinting[];
  ids: CardIdentityIds;
}

/** User-controlled deck-level information. */
export interface DeckInfo {
  name: string;
  /** Source format id, lowercase (e.g. `commander`). */
  format: string;
  /** Short deck description (not the primer). Line endings normalized to `\n`. */
  description: string;
  /** Deck-level tags from the source (Moxfield "hubs"), sorted, unique. */
  tags: string[];
}

/**
 * Cards per zone. Only non-empty zones are present (an empty zone and an absent zone
 * are the same state). Cards within a zone are sorted by key and keys are unique per zone.
 */
export type ZoneMap = Partial<Record<ZoneId, CanonicalCard[]>>;

export interface CanonicalSnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  deck: DeckInfo;
  zones: ZoneMap;
  /**
   * Per-card user tags (Moxfield "author tags"), keyed by card key. Tags apply to the
   * card across zones. Only cards with at least one tag are present; tag lists sorted, unique.
   */
  cardTags: Record<CardKey, string[]>;
  /**
   * Primer markdown with normalized line endings, or `null` when the primer could not
   * be retrieved. `''` means the deck has no primer. `null` is never treated as a deletion.
   */
  primer: string | null;
}

/**
 * Card reference data (oracle facts) used for display only: grouping by type, mana
 * costs, images. Not versioned and never part of a snapshot or its hash.
 */
export interface CardFacts {
  key: CardKey;
  name: string;
  typeLine: string;
  /** Primary type used for grouping, e.g. `Creature`, `Instant`, `Land`. */
  primaryType: string;
  manaCost: string;
  cmc: number;
  /** WUBRG letters, sorted in WUBRG order. */
  colorIdentity: string[];
  layout: string;
  /** A representative Scryfall printing id, used for card images. */
  scryfallId?: string;
}

/** Source-reported metadata for a fetched deck. Volatile; never part of the canonical snapshot. */
export interface SourceDeckMetadata {
  /** Source id, e.g. `moxfield`. */
  source: string;
  /** Public deck id on the source, e.g. Moxfield `publicId`. */
  externalId: string;
  /** Source-internal deck id if different from the public id (Moxfield `id`). */
  internalId?: string;
  url: string;
  name: string;
  format: string;
  visibility?: string;
  /** Monotonic deck revision counter if the source exposes one (Moxfield `version`). */
  version?: number;
  /** ISO timestamp of the last deck edit on the source. */
  lastUpdatedAt?: string;
  createdAt?: string;
  /** ISO timestamp of the last primer edit, when known. */
  primerLastUpdatedAt?: string;
  authors: string[];
  /** Card counts per zone as reported by the source (for cross-checking). */
  reportedCounts: Partial<Record<ZoneId, number>>;
}

export type IngestWarningCode =
  | 'unknown-zone'
  | 'merged-duplicate-entries'
  | 'missing-field'
  | 'invalid-quantity'
  | 'primer-unavailable'
  | 'count-mismatch'
  | 'unexpected-shape';

/** A non-fatal problem found while normalizing source data. Shown to the user, never silently dropped. */
export interface IngestWarning {
  code: IngestWarningCode;
  message: string;
  /** Optional machine-readable context (zone, card name, field path, ...). */
  details?: Record<string, string | number | boolean | null>;
}

/** Result of normalizing a raw source payload. */
export interface NormalizedDeck {
  snapshot: CanonicalSnapshot;
  metadata: SourceDeckMetadata;
  catalog: CardFacts[];
  warnings: IngestWarning[];
}
