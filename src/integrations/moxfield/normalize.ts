/**
 * Normalization of Moxfield payloads into the canonical deck model.
 *
 * Pure and deterministic: boards are processed in canonical zone order and entries in
 * ordinal entry-key order, so the result (including warnings and which source ids win
 * when entries merge) does not depend on JSON key order. Problems with individual
 * entries become {@link IngestWarning}s; only missing essentials (deck identity, boards)
 * are fatal.
 */
import {
  CanonicalizationError,
  canonicalizeSnapshot,
  compareStrings,
  printingIdentity,
} from '@/core/canonical';
import { cardKey, normalizeCardName } from '@/core/card-key';
import type {
  CanonicalCard,
  CanonicalPrinting,
  CanonicalSnapshot,
  CardFacts,
  CardIdentityIds,
  CardKey,
  IngestWarning,
  NormalizedDeck,
  SourceDeckMetadata,
  ZoneMap,
} from '@/core/model';
import { SNAPSHOT_SCHEMA_VERSION } from '@/core/model';
import { compareZones, isKnownZone, zoneLabel, type ZoneId } from '@/core/zones';

import { DeckSourceError } from '../deck-source';

import { DEFAULT_MOXFIELD_SITE_ORIGIN, MOXFIELD_SOURCE_ID, zoneForBoard } from './constants';
import {
  isPlainObject,
  LEGACY_BOARD_NAMES,
  parseMoxfieldBoard,
  parseMoxfieldBoardEntry,
  parseMoxfieldCard,
  parseMoxfieldDeck,
  parseMoxfieldPrimer,
  type MoxfieldCard,
  type MoxfieldDeck,
  type MoxfieldPayloadData,
  type PlainObject,
} from './schema';
import { moxfieldDeckUrl } from './url';

export interface NormalizeMoxfieldOptions {
  /** Origin used for the canonical deck URL in metadata. Defaults to `https://moxfield.com`. */
  siteOrigin?: string;
}

/** A board as found in the payload, in either the v3 or the legacy v2 shape. */
interface SourceBoard {
  name: string;
  zone: ZoneId;
  /** JSON path of the board, for messages (`boards.mainboard` or `mainboard`). */
  path: string;
  reportedCount: number | undefined;
  cards: PlainObject;
}

/** One accepted board entry. */
interface SourceEntry {
  name: string;
  quantity: number;
  printing: CanonicalPrinting | null;
  uniqueCardId: string | undefined;
}

/** All accepted entries of one card in one zone. */
interface CardGroup {
  zone: ZoneId;
  key: CardKey;
  entries: SourceEntry[];
}

/**
 * Layouts whose card-level `type_line` and `mana_cost` describe both faces
 * (`A // B`, or an empty cost); their front face is used for display facts instead.
 */
const FRONT_FACE_LAYOUTS: ReadonlySet<string> = new Set([
  'transform',
  'modal_dfc',
  'flip',
  'meld',
  'reversible_card',
  'double_faced_token',
]);

/**
 * Card types in grouping precedence: a card is grouped under the first type in this
 * list that appears on its (front face) type line. Creature wins over everything, so
 * `Artifact Creature` and `Land Creature` (Dryad Arbor) are creatures; Land wins over
 * Artifact, so artifact lands count as lands; Artifact wins over Enchantment for the
 * rare `Enchantment Artifact`. This mirrors the groups Moxfield shows (Creature,
 * Planeswalker, Battle, Instant, Sorcery, Artifact, Enchantment, Land).
 */
const PRIMARY_TYPE_PRECEDENCE = [
  'Creature',
  'Planeswalker',
  'Battle',
  'Land',
  'Instant',
  'Sorcery',
  'Artifact',
  'Enchantment',
] as const;

const WUBRG = ['W', 'U', 'B', 'R', 'G'] as const;

/**
 * Primary type of a type line for grouping, by {@link PRIMARY_TYPE_PRECEDENCE}.
 * Only the front face (before `//`) counts. Type lines without any of those types
 * (planes, schemes, conspiracies, ...) use their last card type word, e.g.
 * `Ongoing Scheme` → `Scheme`; an empty type line gives `Other`.
 */
export function primaryCardType(typeLine: string): string {
  const front = typeLine.split('//')[0] ?? '';
  const types = (front.split(/\s+[—–-]\s+|—/)[0] ?? '').trim();
  const words = types.split(/\s+/).filter((word) => word.length > 0);
  const lower = new Set(words.map((word) => word.toLowerCase()));
  const match = PRIMARY_TYPE_PRECEDENCE.find((type) => lower.has(type.toLowerCase()));
  if (match !== undefined) return match;
  const last = words.at(-1);
  return last === undefined ? 'Other' : last.charAt(0).toUpperCase() + last.slice(1);
}

/** Maps Moxfield finishes (`nonFoil`, `foil`, `etched`) to canonical ones; others are lowercased. */
function normalizeFinish(finish: string | undefined, isFoil: boolean | undefined): string {
  const value = nonEmpty(finish)?.toLowerCase();
  if (value === undefined) return isFoil === true ? 'foil' : 'nonfoil';
  return value === 'non-foil' ? 'nonfoil' : value;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Normalizes Moxfield's UTC timestamps to ISO-8601 with milliseconds. Timestamps
 * without a zone designator are UTC by Moxfield's field naming. Unparseable values
 * are dropped (metadata only).
 */
function normalizeTimestamp(value: string | undefined): string | undefined {
  const text = nonEmpty(value);
  if (text === undefined) return undefined;
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) || !text.includes('T') ? text : `${text}Z`;
  const ms = Date.parse(zoned);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function schemaError(message: string, issues: readonly string[]): DeckSourceError {
  const detail = issues.length > 0 ? ` ${issues.slice(0, 20).join('; ')}` : '';
  return new DeckSourceError('schema', `${message}${detail}`, { source: MOXFIELD_SOURCE_ID });
}

class WarningCollector {
  readonly list: IngestWarning[] = [];

  add(code: IngestWarning['code'], message: string, details?: IngestWarning['details']): void {
    this.list.push(details === undefined ? { code, message } : { code, message, details });
  }
}

/** Short description of an untrusted value for warning details. */
function describeValue(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  return Array.isArray(value) ? 'array' : typeof value;
}

/**
 * Finds the boards of a deck in the v3 shape (`boards`) or, failing that, the legacy
 * v2 shape (top-level maps). A `mainboard` board is required in both shapes: every
 * Moxfield deck has one (possibly empty), so its absence signals a format change that
 * must not be mistaken for an emptied deck.
 */
function collectBoards(rawDeck: PlainObject, deck: MoxfieldDeck, warnings: WarningCollector): SourceBoard[] {
  const boards: SourceBoard[] = [];
  const issues: string[] = [];

  if (deck.boards !== undefined) {
    for (const [name, value] of Object.entries(deck.boards)) {
      if (value === null || value === undefined) continue;
      const path = `boards.${name}`;
      const zone = zoneForBoard(name);
      const parsed = parseMoxfieldBoard(value, path);
      if (parsed.ok) {
        boards.push({ name, zone, path, reportedCount: parsed.value.count, cards: parsed.value.cards });
      } else if (isKnownZone(zone)) {
        issues.push(...parsed.issues);
      } else {
        warnings.add(
          'unexpected-shape',
          `Moxfield board "${name}" has an unexpected shape and was skipped.`,
          {
            board: name,
            issues: parsed.issues.join('; '),
          },
        );
      }
    }
  } else {
    for (const name of LEGACY_BOARD_NAMES) {
      const cards = rawDeck[name];
      if (!isPlainObject(cards)) continue;
      const count = rawDeck[`${name}Count`];
      boards.push({
        name,
        zone: zoneForBoard(name),
        path: name,
        reportedCount: typeof count === 'number' ? count : undefined,
        cards,
      });
    }
  }

  if (issues.length === 0 && !boards.some((board) => board.name === 'mainboard')) {
    issues.push(
      deck.boards === undefined
        ? 'boards: Invalid input: expected `boards` (v3) or top-level board maps such as `mainboard` (v2)'
        : 'boards.mainboard: Invalid input: expected a board',
    );
  }
  if (issues.length > 0) throw schemaError('The Moxfield deck has an unrecognized shape.', issues);
  return boards.sort((a, b) => compareZones(a.zone, b.zone) || compareStrings(a.name, b.name));
}

function readEntry(
  board: SourceBoard,
  entryKey: string,
  rawEntry: unknown,
  warnings: WarningCollector,
): { entry: SourceEntry; card: MoxfieldCard } | null {
  const path = `${board.path}.cards.${entryKey}`;
  const base = { board: board.name, zone: board.zone, entry: entryKey };

  const parsedEntry = parseMoxfieldBoardEntry(rawEntry, path);
  if (!parsedEntry.ok) {
    warnings.add('unexpected-shape', `Skipped an unreadable entry in Moxfield board "${board.name}".`, {
      ...base,
      issues: parsedEntry.issues.join('; '),
    });
    return null;
  }
  const entry = parsedEntry.value;

  const parsedCard = parseMoxfieldCard(entry.card, `${path}.card`);
  if (!parsedCard.ok) {
    warnings.add('missing-field', `Skipped an entry without a card name in Moxfield board "${board.name}".`, {
      ...base,
      issues: parsedCard.issues.join('; '),
    });
    return null;
  }
  const card = parsedCard.value;
  const name = normalizeCardName(card.name);

  const quantity = entry.quantity;
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1) {
    warnings.add('invalid-quantity', `Skipped ${name} in ${zoneLabel(board.zone)}: invalid quantity.`, {
      ...base,
      card: name,
      quantity: describeValue(quantity),
    });
    return null;
  }

  const set = nonEmpty(card.set);
  const collectorNumber = nonEmpty(card.cn);
  let printing: CanonicalPrinting | null = null;
  if (set === undefined || collectorNumber === undefined) {
    warnings.add('missing-field', `${name} in ${zoneLabel(board.zone)} has no set or collector number.`, {
      ...base,
      card: name,
      field: set === undefined ? 'card.set' : 'card.cn',
    });
  } else {
    const flags = [
      ...(entry.isAlter === true ? ['alter'] : []),
      ...(entry.isProxy === true ? ['proxy'] : []),
    ];
    printing = {
      set: set.toLowerCase(),
      collectorNumber,
      finish: normalizeFinish(entry.finish, entry.isFoil),
      lang: (nonEmpty(card.lang) ?? 'en').toLowerCase(),
      quantity,
      ids: { scryfall: nonEmpty(card.scryfall_id), moxfield: nonEmpty(card.id) },
    };
    if (flags.length > 0) printing.flags = flags;
  }

  return { entry: { name, quantity, printing, uniqueCardId: nonEmpty(card.uniqueCardId) }, card };
}

function cardFacts(key: CardKey, name: string, card: MoxfieldCard): CardFacts {
  const layout = nonEmpty(card.layout) ?? 'normal';
  const front = FRONT_FACE_LAYOUTS.has(layout) ? (card.card_faces?.[0] ?? undefined) : undefined;
  const typeLine = front?.type_line ?? card.type_line ?? '';
  const colors = new Set((card.color_identity ?? []).map((color) => color.trim().toUpperCase()));
  const facts: CardFacts = {
    key,
    name,
    typeLine,
    primaryType: primaryCardType(typeLine),
    manaCost: front?.mana_cost ?? card.mana_cost ?? '',
    cmc: card.cmc ?? 0,
    colorIdentity: WUBRG.filter((color) => colors.has(color)),
    layout,
  };
  const scryfallId = nonEmpty(card.scryfall_id);
  if (scryfallId !== undefined) facts.scryfallId = scryfallId;
  return facts;
}

/** Builds one card per (zone, key), reporting merged duplicates and dropped printings. */
function buildZoneCard(group: CardGroup, warnings: WarningCollector): CanonicalCard {
  const [first] = group.entries;
  const name = first?.name ?? group.key;
  const details = { zone: group.zone, card: name, entries: group.entries.length };

  const printings: CanonicalPrinting[] = [];
  for (const entry of group.entries) if (entry.printing !== null) printings.push(entry.printing);
  const complete = printings.length === group.entries.length;
  if (!complete && printings.length > 0) {
    warnings.add(
      'missing-field',
      `Printing details of ${name} in ${zoneLabel(group.zone)} were dropped because some entries lack them.`,
      details,
    );
  }

  // Only entries with known printings can be identified as true duplicates.
  const identities = printings.map((p) => printingIdentity(p));
  if (new Set(identities).size < identities.length) {
    warnings.add(
      'merged-duplicate-entries',
      `${name} appears in several identical entries in ${zoneLabel(group.zone)}; they were merged.`,
      details,
    );
  }

  const ids: CardIdentityIds = {};
  for (const entry of group.entries) ids.moxfield ??= entry.uniqueCardId;

  return {
    key: group.key,
    name,
    quantity: group.entries.reduce((n, entry) => n + entry.quantity, 0),
    printings: complete ? printings : [],
    ids,
  };
}

/**
 * Author tags (`{ [cardName]: string[] }`) keyed by card key. Tags are kept as Moxfield
 * reports them, including tags of cards that are not currently in any board.
 */
function collectCardTags(deck: MoxfieldDeck): Record<CardKey, string[]> {
  const tagsByKey = new Map<CardKey, string[]>();
  for (const [cardName, tags] of Object.entries(deck.authorTags ?? {})) {
    const key = cardKey(cardName);
    if (!Array.isArray(tags) || key.length === 0) continue;
    const valid = tags.filter((tag): tag is string => typeof tag === 'string');
    if (valid.length > 0) tagsByKey.set(key, [...(tagsByKey.get(key) ?? []), ...valid]);
  }
  return Object.fromEntries(tagsByKey);
}

function readPrimer(
  data: MoxfieldPayloadData,
  warnings: WarningCollector,
): { primer: string | null; lastUpdatedAt: string | undefined } {
  if (data.primerError !== undefined) {
    warnings.add('primer-unavailable', `The primer could not be retrieved: ${data.primerError}`);
    return { primer: null, lastUpdatedAt: undefined };
  }
  if (data.primer === null || data.primer === undefined) {
    warnings.add('primer-unavailable', 'The primer was not captured.');
    return { primer: null, lastUpdatedAt: undefined };
  }
  const parsed = parseMoxfieldPrimer(data.primer);
  if (!parsed.ok) {
    warnings.add('primer-unavailable', 'The primer data was not recognized and was ignored.', {
      issues: parsed.issues.join('; '),
    });
    return { primer: null, lastUpdatedAt: undefined };
  }
  return { primer: parsed.value.content, lastUpdatedAt: normalizeTimestamp(parsed.value.lastUpdatedAtUtc) };
}

/** Wraps canonicalization failures (which validated input should never cause) as schema errors. */
function canonicalize(input: CanonicalSnapshot): CanonicalSnapshot {
  try {
    return canonicalizeSnapshot(input);
  } catch (error) {
    if (!(error instanceof CanonicalizationError)) throw error;
    throw new DeckSourceError('schema', `The Moxfield deck could not be normalized: ${error.message}`, {
      source: MOXFIELD_SOURCE_ID,
      cause: error,
    });
  }
}

/** Creator first, then co-authors, without duplicates. */
function uniqueAuthors(deck: MoxfieldDeck): string[] {
  const authors = new Set<string>();
  for (const user of [deck.createdByUser, ...(deck.authors ?? [])]) {
    const userName = nonEmpty(user?.userName);
    if (userName !== undefined) authors.add(userName);
  }
  return [...authors];
}

/**
 * Converts a Moxfield payload (deck JSON in the v3 or legacy v2 shape, plus primer
 * JSON) into the canonical model.
 *
 * - Boards map to zones via `BOARD_TO_ZONE`; unknown non-empty boards become
 *   `other:<slug>` zones with an `unknown-zone` warning. `boardType` is ignored.
 * - Entries with an invalid quantity or without a card name are skipped with a warning.
 * - Entries of the same card in one zone are combined; entries that are identical in
 *   printing too are reported as `merged-duplicate-entries`.
 * - Board counts that disagree with the accepted entries produce `count-mismatch`.
 * - A missing, failed or unrecognized primer gives `primer: null` plus a warning.
 *
 * @throws {DeckSourceError} code `schema` when the deck id, name or boards are unusable.
 */
export function normalizeMoxfieldPayload(
  data: MoxfieldPayloadData,
  options: NormalizeMoxfieldOptions = {},
): NormalizedDeck {
  const parsedDeck = parseMoxfieldDeck(data.deck);
  if (!parsedDeck.ok) throw schemaError('The Moxfield deck data is not usable.', parsedDeck.issues);
  const deck = parsedDeck.value;
  const rawDeck = isPlainObject(data.deck) ? data.deck : {};
  const warnings = new WarningCollector();

  const groups = new Map<string, CardGroup>();
  const catalog = new Map<CardKey, CardFacts>();
  const reportedCounts = new Map<ZoneId, number>();

  for (const board of collectBoards(rawDeck, deck, warnings)) {
    const entries = Object.entries(board.cards).sort(([a], [b]) => compareStrings(a, b));
    if (entries.length > 0 && !isKnownZone(board.zone)) {
      warnings.add(
        'unknown-zone',
        `Moxfield board "${board.name}" is not known to git-moxfield; its cards are kept in "${board.zone}".`,
        { board: board.name, zone: board.zone },
      );
    }
    if (board.reportedCount !== undefined) {
      reportedCounts.set(board.zone, (reportedCounts.get(board.zone) ?? 0) + board.reportedCount);
    }

    let counted = 0;
    for (const [entryKey, rawEntry] of entries) {
      const read = readEntry(board, entryKey, rawEntry, warnings);
      if (read === null) continue;
      const key = cardKey(read.entry.name);
      counted += read.entry.quantity;
      const groupId = `${board.zone}\u0000${key}`;
      const group = groups.get(groupId);
      if (group) group.entries.push(read.entry);
      else groups.set(groupId, { zone: board.zone, key, entries: [read.entry] });
      if (!catalog.has(key)) catalog.set(key, cardFacts(key, read.entry.name, read.card));
    }

    if (board.reportedCount !== undefined && board.reportedCount !== counted) {
      warnings.add(
        'count-mismatch',
        `Moxfield reports ${board.reportedCount} cards in "${board.name}", but ${counted} were read.`,
        { board: board.name, zone: board.zone, reported: board.reportedCount, counted },
      );
    }
  }

  const zones: ZoneMap = {};
  for (const group of groups.values()) {
    (zones[group.zone] ??= []).push(buildZoneCard(group, warnings));
  }

  const { primer, lastUpdatedAt: primerLastUpdatedAt } = readPrimer(data, warnings);

  const snapshot = canonicalize({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    deck: {
      name: deck.name,
      format: deck.format ?? '',
      description: deck.description ?? '',
      tags: (deck.hubs ?? []).filter((hub): hub is string => hub !== null),
    },
    zones,
    cardTags: collectCardTags(deck),
    primer,
  });

  const metadata: SourceDeckMetadata = {
    source: MOXFIELD_SOURCE_ID,
    externalId: deck.publicId,
    url: moxfieldDeckUrl(deck.publicId, options.siteOrigin ?? DEFAULT_MOXFIELD_SITE_ORIGIN),
    name: snapshot.deck.name,
    format: snapshot.deck.format,
    authors: uniqueAuthors(deck),
    reportedCounts: Object.fromEntries(
      [...reportedCounts]
        .filter(([zone, count]) => count > 0 || snapshot.zones[zone] !== undefined)
        .sort(([a], [b]) => compareZones(a, b)),
    ),
  };
  const internalId = nonEmpty(deck.id);
  if (internalId !== undefined) metadata.internalId = internalId;
  const visibility = nonEmpty(deck.visibility);
  if (visibility !== undefined) metadata.visibility = visibility;
  if (deck.version !== undefined) metadata.version = deck.version;
  const lastUpdatedAt = normalizeTimestamp(deck.lastUpdatedAtUtc);
  if (lastUpdatedAt !== undefined) metadata.lastUpdatedAt = lastUpdatedAt;
  const createdAt = normalizeTimestamp(deck.createdAtUtc);
  if (createdAt !== undefined) metadata.createdAt = createdAt;
  if (primerLastUpdatedAt !== undefined) metadata.primerLastUpdatedAt = primerLastUpdatedAt;

  return {
    snapshot,
    metadata,
    catalog: [...catalog.values()].sort((a, b) => compareStrings(a.key, b.key)),
    warnings: warnings.list,
  };
}
