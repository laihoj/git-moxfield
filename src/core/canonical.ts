/**
 * Canonicalization and deterministic serialization of deck snapshots.
 *
 * `canonicalizeSnapshot` is idempotent and is the only way snapshots should be
 * produced from adapter output: it merges duplicates, sorts everything, drops empty
 * zones and normalizes text so semantically identical states are byte-identical
 * under `stableStringify`.
 */
import { cardKey, normalizeCardName } from './card-key';
import { getOrCreate } from './collections';
import type {
  CanonicalCard,
  CanonicalPrinting,
  CanonicalSnapshot,
  CardIdentityIds,
  CardKey,
  DeckInfo,
  PrintingIds,
  ZoneMap,
} from './model';
import { SNAPSHOT_SCHEMA_VERSION } from './model';
import { normalizeInlineText } from './text';
import { isPlayedZone, isZoneId, sortZones, type ZoneId } from './zones';

export class CanonicalizationError extends Error {
  override readonly name = 'CanonicalizationError';
}

/** The empty deck. Used as the "before" side of a deck's first version. */
export function emptySnapshot(deck?: Partial<DeckInfo>): CanonicalSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    deck: {
      name: deck?.name ?? '',
      format: deck?.format ?? '',
      description: deck?.description ?? '',
      tags: deck?.tags ? normalizeTagList(deck.tags) : [],
    },
    zones: {},
    cardTags: {},
    primer: '',
  };
}

/** Normalizes multi-line text: NFC, CRLF/CR → LF. Inner whitespace is preserved. */
export function normalizeText(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n');
}

/**
 * Normalizes primer markdown: NFC, LF line endings, trailing whitespace at the end of
 * the document removed, and exactly one trailing newline when non-empty.
 *
 * Trailing whitespace is removed with `trimEnd` (the same characters as `\s`), never
 * with a `/\s+$/` regex: that backtracks quadratically on a long whitespace run
 * followed by text, and primers are untrusted input of up to megabytes.
 */
export function normalizePrimer(primer: string | null): string | null {
  if (primer === null) return null;
  const text = normalizeText(primer).trimEnd();
  return text.length === 0 ? '' : `${text}\n`;
}

/** Trims, NFC-normalizes, deduplicates and sorts a tag list. Empty tags are dropped. */
export function normalizeTagList(tags: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const tag of tags) {
    const normalized = normalizeInlineText(tag);
    if (normalized) unique.add(normalized);
  }
  return [...unique].sort(compareStrings);
}

/** Ordinal string comparison (UTF-16 code units). Locale-independent and stable. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Identity of a printing for merging and comparison. Source ids are excluded. */
export function printingIdentity(
  p: Pick<CanonicalPrinting, 'set' | 'collectorNumber' | 'finish' | 'lang' | 'flags'>,
): string {
  return [p.set, p.collectorNumber, p.finish, p.lang, (p.flags ?? []).join(',')].join('\u0000');
}

function comparePrintings(a: CanonicalPrinting, b: CanonicalPrinting): number {
  return (
    compareStrings(a.set, b.set) ||
    compareCollectorNumbers(a.collectorNumber, b.collectorNumber) ||
    compareStrings(a.finish, b.finish) ||
    compareStrings(a.lang, b.lang) ||
    compareStrings((a.flags ?? []).join(','), (b.flags ?? []).join(','))
  );
}

/**
 * Natural ordering for collector numbers: `2` < `10` < `10a` < `1492★`. Numbers with a
 * leading run of ASCII digits compare by that number first, then by the remainder, then
 * ordinally; all other numbers compare ordinally. This is a total order (every
 * digit-led string takes the numeric path), so sorting is independent of input order.
 */
function compareCollectorNumbers(a: string, b: string): number {
  const na = /^(\d+)(.*)$/s.exec(a);
  const nb = /^(\d+)(.*)$/s.exec(b);
  if (na && nb) {
    const [, digitsA = '', restA = ''] = na;
    const [, digitsB = '', restB = ''] = nb;
    return compareDigits(digitsA, digitsB) || compareStrings(restA, restB) || compareStrings(a, b);
  }
  return compareStrings(a, b);
}

/** Compares non-negative decimal digit strings by value, without precision loss. */
function compareDigits(a: string, b: string): number {
  const ta = a.replace(/^0+/, '');
  const tb = b.replace(/^0+/, '');
  if (ta.length !== tb.length) return ta.length < tb.length ? -1 : 1;
  return compareStrings(ta, tb);
}

function assertPositiveInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CanonicalizationError(`${what} must be a positive integer, got ${String(value)}`);
  }
}

/** Drops empty ids and orders keys; works for both card and printing id objects. */
function cleanIds(ids: CardIdentityIds | PrintingIds | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (ids) {
    const entries = Object.entries(ids as Record<string, unknown>).sort(([a], [b]) => compareStrings(a, b));
    for (const [key, value] of entries) {
      if (typeof value === 'string' && value.length > 0) out[key] = value;
    }
  }
  return out;
}

function canonicalizePrinting(p: CanonicalPrinting, context: string): CanonicalPrinting {
  assertPositiveInteger(p.quantity, `${context} printing quantity`);
  const printing: CanonicalPrinting = {
    set: p.set.normalize('NFC').trim().toLowerCase(),
    collectorNumber: p.collectorNumber.normalize('NFC').trim(),
    finish: p.finish.normalize('NFC').trim().toLowerCase(),
    lang: p.lang.normalize('NFC').trim().toLowerCase(),
    quantity: p.quantity,
    ids: cleanIds(p.ids),
  };
  const flags = p.flags ? normalizeTagList(p.flags.map((f) => f.toLowerCase())) : [];
  if (flags.length > 0) printing.flags = flags;
  return printing;
}

/** Keeps the first non-empty value for each id; deterministic given ordered input. */
function mergeIds(
  a: CardIdentityIds | PrintingIds,
  b: CardIdentityIds | PrintingIds,
): Record<string, string> {
  return cleanIds({ ...cleanIds(b), ...cleanIds(a) });
}

/** Merges entries of the same card within one zone and sorts printings. */
function canonicalizeZoneCards(cards: readonly CanonicalCard[], zone: ZoneId): CanonicalCard[] {
  const byKey = new Map<CardKey, CanonicalCard>();
  for (const raw of cards) {
    const name = normalizeCardName(raw.name);
    if (!name) throw new CanonicalizationError(`Card in zone ${zone} has an empty name`);
    const key = cardKey(name);
    assertPositiveInteger(raw.quantity, `Quantity of ${name} in ${zone}`);
    const printings = raw.printings.map((p) => canonicalizePrinting(p, `${name} in ${zone}`));
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { key, name, quantity: raw.quantity, printings, ids: cleanIds(raw.ids) });
      continue;
    }
    existing.quantity += raw.quantity;
    existing.ids = mergeIds(existing.ids, raw.ids);
    existing.printings.push(...printings);
  }

  const result: CanonicalCard[] = [];
  for (const card of byKey.values()) {
    const merged = new Map<string, CanonicalPrinting>();
    for (const p of card.printings) {
      const id = printingIdentity(p);
      const existing = merged.get(id);
      if (existing) {
        existing.quantity += p.quantity;
        existing.ids = mergeIds(existing.ids, p.ids);
      } else {
        merged.set(id, { ...p, ids: { ...p.ids } });
      }
    }
    const printings = [...merged.values()].sort(comparePrintings);
    const printed = printings.reduce((n, p) => n + p.quantity, 0);
    if (printings.length > 0 && printed !== card.quantity) {
      throw new CanonicalizationError(
        `Printing quantities of ${card.name} in ${zone} sum to ${printed}, expected ${card.quantity}`,
      );
    }
    result.push({ key: card.key, name: card.name, quantity: card.quantity, printings, ids: card.ids });
  }
  return result.sort((a, b) => compareStrings(a.key, b.key));
}

/**
 * Produces the canonical form of a snapshot. Idempotent:
 * `canonicalizeSnapshot(canonicalizeSnapshot(s))` deep-equals `canonicalizeSnapshot(s)`.
 *
 * @throws {CanonicalizationError} on invalid zone ids, non-positive quantities, empty
 * names, or printing quantities that do not add up.
 */
export function canonicalizeSnapshot(input: CanonicalSnapshot): CanonicalSnapshot {
  const zoneIds: ZoneId[] = [];
  for (const zone of Object.keys(input.zones)) {
    if (!isZoneId(zone)) throw new CanonicalizationError(`Invalid zone id: ${zone}`);
    zoneIds.push(zone);
  }
  const zones: ZoneMap = {};
  for (const zone of sortZones(zoneIds)) {
    const cards = canonicalizeZoneCards(input.zones[zone] ?? [], zone);
    if (cards.length > 0) zones[zone] = cards;
  }

  // A Map, not a plain object: card keys are user data and may be `constructor` or
  // `__proto__`, which a plain-object lookup or assignment would resolve to Object.prototype.
  const tagsByKey = new Map<CardKey, string[]>();
  const tagEntries = Object.entries(input.cardTags)
    .map(([key, tags]) => [cardKey(key), tags] as const)
    .sort(([a], [b]) => compareStrings(a, b));
  for (const [key, tags] of tagEntries) {
    const merged = normalizeTagList([...(tagsByKey.get(key) ?? []), ...tags]);
    if (merged.length > 0) tagsByKey.set(key, merged);
  }
  const cardTags: Record<CardKey, string[]> = Object.fromEntries(tagsByKey);

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    deck: {
      name: normalizeText(input.deck.name).trim(),
      format: input.deck.format.normalize('NFC').trim().toLowerCase(),
      description: normalizeText(input.deck.description).trimEnd(),
      tags: normalizeTagList(input.deck.tags),
    },
    zones,
    cardTags,
    primer: normalizePrimer(input.primer),
  };
}

/**
 * Deterministic JSON serialization: object keys sorted by UTF-16 code units, no
 * whitespace, `undefined` properties omitted. Arrays keep their (canonical) order;
 * `undefined` array elements and holes become `null`, as in `JSON.stringify`.
 *
 * @throws {TypeError} for values JSON cannot represent faithfully (functions, symbols,
 * bigint, non-finite numbers, `undefined` at the top level) and for objects that are
 * not plain objects or arrays (`Date`, `Map`, class instances, ...), which would
 * otherwise be serialized lossily.
 */
export function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`Cannot serialize non-finite number ${value}`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        const items = Array.from(value as unknown[], (v) => (v === undefined ? 'null' : stableStringify(v)));
        return `[${items.join(',')}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`Cannot serialize non-plain object ${Object.prototype.toString.call(value)}`);
      }
      const record = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort(compareStrings)) {
        const v = record[key];
        if (v === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`Cannot serialize value of type ${typeName(value)}`);
  }
}

function typeName(value: unknown): string {
  return typeof value;
}

/** All cards of a zone (empty array when the zone is absent). */
export function zoneCards(snapshot: CanonicalSnapshot, zone: ZoneId): CanonicalCard[] {
  return snapshot.zones[zone] ?? [];
}

/** Zones present in the snapshot, in canonical order. */
export function snapshotZones(snapshot: CanonicalSnapshot): ZoneId[] {
  return sortZones(Object.keys(snapshot.zones) as ZoneId[]);
}

/** Total copies in a zone. */
export function zoneCount(snapshot: CanonicalSnapshot, zone: ZoneId): number {
  return zoneCards(snapshot, zone).reduce((n, c) => n + c.quantity, 0);
}

/** Total copies in played zones (commanders, companions, signature spells, mainboard). */
export function playedCardCount(snapshot: CanonicalSnapshot): number {
  return snapshotZones(snapshot)
    .filter(isPlayedZone)
    .reduce((n, zone) => n + zoneCount(snapshot, zone), 0);
}

/** Commander display names, sorted by key. */
export function commanderNames(snapshot: CanonicalSnapshot): string[] {
  return zoneCards(snapshot, 'commanders').map((c) => c.name);
}

/** Map of card key → (zone → quantity) for the whole snapshot. */
export function cardZoneIndex(snapshot: CanonicalSnapshot): Map<CardKey, Map<ZoneId, number>> {
  const index = new Map<CardKey, Map<ZoneId, number>>();
  for (const zone of snapshotZones(snapshot)) {
    for (const card of zoneCards(snapshot, zone)) {
      const zones = getOrCreate(index, card.key, () => new Map<ZoneId, number>());
      zones.set(zone, (zones.get(zone) ?? 0) + card.quantity);
    }
  }
  return index;
}

/** Finds a card entry by key in a zone. */
export function findCard(snapshot: CanonicalSnapshot, zone: ZoneId, key: CardKey): CanonicalCard | undefined {
  return zoneCards(snapshot, zone).find((c) => c.key === key);
}

/** Display name of every card by key: the first zone in canonical order that has the card names it. */
export function cardNames(snapshot: CanonicalSnapshot): Map<CardKey, string> {
  const names = new Map<CardKey, string>();
  for (const zone of snapshotZones(snapshot)) {
    for (const card of zoneCards(snapshot, zone)) if (!names.has(card.key)) names.set(card.key, card.name);
  }
  return names;
}

/** Display name of one card (see {@link cardNames}), or `undefined` when the snapshot has no such card. */
export function cardName(snapshot: CanonicalSnapshot, key: CardKey): string | undefined {
  for (const zone of snapshotZones(snapshot)) {
    const card = findCard(snapshot, zone, key);
    if (card) return card.name;
  }
  return undefined;
}

/** All distinct card keys with their display name, sorted by key. */
export function allCards(snapshot: CanonicalSnapshot): { key: CardKey; name: string }[] {
  return [...cardNames(snapshot)]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([key, name]) => ({ key, name }));
}
