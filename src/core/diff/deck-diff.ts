/**
 * Semantic deck diff.
 *
 * {@link diffSnapshots} implements the algorithm specified in `docs/architecture.md`
 * ("Semantic diff"): stable-id rename reconciliation, per-key zone deltas, move
 * detection *before* anything is classified as an addition or removal, residual
 * classification, cosmetic printing and card tag changes, deck info, primer and the
 * commander summary.
 *
 * The diff is pure and deterministic. Inputs are never mutated, the result shares no
 * mutable objects with them, and the work is linear in the number of card entries
 * (plus sorting the resulting changes).
 */
import { commanderNames, compareStrings, printingIdentity, snapshotZones, zoneCards } from '../canonical';
import { getOrCreate, groupInto } from '../collections';
import type { CanonicalPrinting, CanonicalSnapshot, CardKey, DeckInfo } from '../model';
import { primerChange } from '../primer/primer-diff';
import { compareZones, zoneEntries, type ZoneId } from '../zones';
import {
  primerHasChange,
  STRATEGIC_CHANGE_TYPES,
  type AddedChange,
  type CardChange,
  type CardChangeType,
  type CardTagsChange,
  type CommanderSummary,
  type DeckDiff,
  type DeckInfoChange,
  type DiffStats,
  type MovedChange,
  type MoveStats,
  type PrintingChange,
  type QuantityChange,
  type RemovedChange,
  type RenamedChange,
  type ZoneDiffStats,
} from './types';

/** Rank of each change type in {@link DeckDiff.changes}. */
const CHANGE_TYPE_ORDER: Record<CardChangeType, number> = {
  moved: 0,
  added: 1,
  removed: 2,
  quantity: 3,
  printing: 4,
  tags: 5,
  renamed: 6,
};

/**
 * Computes the semantic difference between two canonical snapshots.
 *
 * Comparing HEAD with the current Moxfield state and comparing any two versions use
 * this same function; a missing side (e.g. before the first version) is the empty
 * snapshot. Both inputs must be canonical (see `canonicalizeSnapshot`).
 *
 * Refinements of the documented algorithm:
 * - Rename reconciliation only pairs keys unambiguously: the key that exists only in
 *   `before` must share a stable id with exactly one key that exists only in `after`,
 *   and vice versa. Ambiguous candidates stay an ordinary removal and addition.
 * - A printing comparison needs printing information on both sides. When a source
 *   does not expose printings for one side (empty list), no printing change is
 *   claimed, just like an uncaptured primer is never reported as a change.
 * - `commanders.changed` is true when a strategic change (move, addition, removal,
 *   quantity) touches the commanders zone; printing changes and renames of a
 *   commander are cosmetic and do not count.
 */
export function diffSnapshots(before: CanonicalSnapshot, after: CanonicalSnapshot): DeckDiff {
  const beforeIndex = indexSnapshot(before);
  const afterIndex = indexSnapshot(after);
  const renames = reconcileRenames(beforeIndex, afterIndex);
  const resolveKey = (key: CardKey): CardKey => renames.get(key) ?? key;
  const nameOf = (key: CardKey): string => afterIndex.get(key)?.name ?? beforeIndex.get(key)?.name ?? key;

  const collector = new ChangeCollector();
  for (const [key, zones] of collectZoneDeltas(beforeIndex, afterIndex, resolveKey)) {
    diffCardZones(key, nameOf(key), sortZoneDeltas(zones), collector);
  }

  const tagChanges = diffCardTags(before.cardTags, after.cardTags, resolveKey, nameOf);
  const renameChanges: RenamedChange[] = [];
  for (const [previousKey, key] of renames) {
    renameChanges.push({ type: 'renamed', key, name: nameOf(key), previousName: nameOf(previousKey) });
  }

  const changes = [...collector.changes, ...tagChanges, ...renameChanges].sort(compareCardChanges);
  const deck = diffDeckInfo(before.deck, after.deck);
  const primer = primerChange(before.primer, after.primer);

  const hasCardChanges = changes.some((change) => STRATEGIC_CHANGE_TYPES.has(change.type));
  const hasOtherChanges = deck.length > 0 || primerHasChange(primer);
  const isEmpty = changes.length === 0 && !hasOtherChanges;

  return {
    changes,
    deck,
    primer,
    commanders: commanderSummary(before, after, changes),
    stats: collector.stats(tagChanges.length),
    isEmpty,
    hasCardChanges,
    onlyCosmetic: !isEmpty && !hasCardChanges && !hasOtherChanges,
  };
}

/**
 * Total order of {@link DeckDiff.changes}: by type (moved, added, removed, quantity,
 * printing, tags, renamed), then by zone in canonical zone order (`from`, then `to`
 * for moves; tags and renames have no zone), then by card key.
 */
export function compareCardChanges(a: CardChange, b: CardChange): number {
  const byType = CHANGE_TYPE_ORDER[a.type] - CHANGE_TYPE_ORDER[b.type];
  if (byType !== 0) return byType;
  // Equal types imply zone lists of equal length.
  const zonesB = changeZones(b);
  for (const [i, zoneA] of changeZones(a).entries()) {
    const zoneB = zonesB[i];
    const byZone = zoneB === undefined ? 1 : compareZones(zoneA, zoneB);
    if (byZone !== 0) return byZone;
  }
  return compareStrings(a.key, b.key);
}

/**
 * Zones a change refers to: `[from, to]` for moves, `[zone]` for zone-scoped changes,
 * and `[]` for card tags and renames, which apply to the card across zones.
 */
export function changeZones(change: CardChange): ZoneId[] {
  switch (change.type) {
    case 'moved':
      return [change.from, change.to];
    case 'added':
    case 'removed':
    case 'quantity':
    case 'printing':
      return [change.zone];
    case 'tags':
    case 'renamed':
      return [];
  }
}

/** True when the change concerns `zone` (for moves: as source or destination). */
export function changeTouchesZone(change: CardChange, zone: ZoneId): boolean {
  return changeZones(change).includes(zone);
}

/**
 * The card renames {@link diffSnapshots} reconciles between two snapshots, as old key →
 * new key: each old key exists only in `before`, each new key only in `after`, and the
 * two share a stable id unambiguously. Card history follows a card across exactly
 * these renames, so it agrees with the diff about which cards are the same.
 */
export function renamedKeys(
  before: CanonicalSnapshot,
  after: CanonicalSnapshot,
): ReadonlyMap<CardKey, CardKey> {
  return reconcileRenames(indexSnapshot(before), indexSnapshot(after));
}

// ---------------------------------------------------------------------------
// Indexing and rename reconciliation
// ---------------------------------------------------------------------------

/** Copies and printings of one card key in one zone of one snapshot. */
interface ZoneEntry {
  quantity: number;
  printings: CanonicalPrinting[];
}

/** Everything one snapshot says about one card key. */
interface IndexedCard {
  /** Display name from the first zone (canonical order) that contains the card. */
  name: string;
  zones: Map<ZoneId, ZoneEntry>;
  /** Stable identity tokens, namespaced: `moxfield:<id>`, `scryfallOracle:<id>`. */
  identityTokens: Set<string>;
}

function indexSnapshot(snapshot: CanonicalSnapshot): Map<CardKey, IndexedCard> {
  const index = new Map<CardKey, IndexedCard>();
  for (const zone of snapshotZones(snapshot)) {
    for (const card of zoneCards(snapshot, zone)) {
      const indexed = getOrCreate(index, card.key, () => ({
        name: card.name,
        zones: new Map<ZoneId, ZoneEntry>(),
        identityTokens: new Set<string>(),
      }));
      const entry = indexed.zones.get(zone);
      if (entry) {
        // Canonical snapshots have one entry per (zone, key); merge defensively anyway.
        entry.quantity += card.quantity;
        entry.printings = [...entry.printings, ...card.printings];
      } else {
        indexed.zones.set(zone, { quantity: card.quantity, printings: [...card.printings] });
      }
      if (card.ids.moxfield) indexed.identityTokens.add(`moxfield:${card.ids.moxfield}`);
      if (card.ids.scryfallOracle) indexed.identityTokens.add(`scryfallOracle:${card.ids.scryfallOracle}`);
    }
  }
  return index;
}

/**
 * Maps keys that exist only in `before` to the key they were renamed to in `after`.
 * A pair is reconciled only when each key is the other's sole candidate, so the
 * mapping is injective and never merges two cards.
 */
function reconcileRenames(
  before: ReadonlyMap<CardKey, IndexedCard>,
  after: ReadonlyMap<CardKey, IndexedCard>,
): Map<CardKey, CardKey> {
  const renames = new Map<CardKey, CardKey>();
  const onlyBefore = new Map([...before].filter(([key]) => !after.has(key)));
  const onlyAfter = new Map([...after].filter(([key]) => !before.has(key)));
  if (onlyBefore.size === 0 || onlyAfter.size === 0) return renames;

  const beforeByToken = keysByToken(onlyBefore);
  const afterByToken = keysByToken(onlyAfter);
  for (const [key, card] of onlyBefore) {
    const target = soleCandidate(card, afterByToken);
    if (target === undefined) continue;
    const targetCard = onlyAfter.get(target);
    if (targetCard && soleCandidate(targetCard, beforeByToken) === key) renames.set(key, target);
  }
  return renames;
}

function keysByToken(cards: ReadonlyMap<CardKey, IndexedCard>): Map<string, CardKey[]> {
  const byToken = new Map<string, CardKey[]>();
  for (const [key, card] of cards) {
    for (const token of card.identityTokens) groupInto(byToken, token, key);
  }
  return byToken;
}

/** The only key sharing an identity token with `card`, or `undefined` if none or several. */
function soleCandidate(card: IndexedCard, byToken: ReadonlyMap<string, CardKey[]>): CardKey | undefined {
  let found: CardKey | undefined;
  for (const token of card.identityTokens) {
    for (const key of byToken.get(token) ?? []) {
      if (found === undefined) found = key;
      else if (found !== key) return undefined;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Card zone changes
// ---------------------------------------------------------------------------

/** One card key in one zone, before and after. */
interface ZoneDelta {
  zone: ZoneId;
  before: number;
  after: number;
  beforePrintings: readonly CanonicalPrinting[];
  afterPrintings: readonly CanonicalPrinting[];
}

/** Per (resolved) key, per zone quantities and printings on both sides. */
function collectZoneDeltas(
  beforeIndex: ReadonlyMap<CardKey, IndexedCard>,
  afterIndex: ReadonlyMap<CardKey, IndexedCard>,
  resolveKey: (key: CardKey) => CardKey,
): Map<CardKey, Map<ZoneId, ZoneDelta>> {
  const deltas = new Map<CardKey, Map<ZoneId, ZoneDelta>>();
  const slot = (key: CardKey, zone: ZoneId): ZoneDelta =>
    getOrCreate(
      getOrCreate(deltas, key, () => new Map<ZoneId, ZoneDelta>()),
      zone,
      () => ({ zone, before: 0, after: 0, beforePrintings: [], afterPrintings: [] }),
    );
  // Renames are injective onto keys absent from `before`, so slots never collide.
  for (const [key, card] of beforeIndex) {
    for (const [zone, entry] of card.zones) {
      const delta = slot(resolveKey(key), zone);
      delta.before = entry.quantity;
      delta.beforePrintings = entry.printings;
    }
  }
  for (const [key, card] of afterIndex) {
    for (const [zone, entry] of card.zones) {
      const delta = slot(key, zone);
      delta.after = entry.quantity;
      delta.afterPrintings = entry.printings;
    }
  }
  return deltas;
}

function sortZoneDeltas(zones: ReadonlyMap<ZoneId, ZoneDelta>): ZoneDelta[] {
  return zoneEntries(zones).map(([, delta]) => delta);
}

/**
 * Steps 3–5 of the algorithm for one card. `deltas` are in canonical zone order.
 *
 * Moves pair sources (zones that lost copies) with sinks (zones that gained copies)
 * greedily in canonical zone order. The rest is classified against
 * `base = before - movedOut + movedIn`, so a move combined with a quantity change
 * reads as "moved 1, then 1 → 3" instead of an unrelated removal and addition.
 */
function diffCardZones(key: CardKey, name: string, deltas: readonly ZoneDelta[], out: ChangeCollector): void {
  const movedOut = new Map<ZoneId, number>();
  const movedIn = new Map<ZoneId, number>();
  const sinks = deltas
    .filter((d) => d.after > d.before)
    .map((d) => ({ zone: d.zone, remaining: d.after - d.before }));

  for (const source of deltas) {
    let remaining = source.before - source.after;
    for (const sink of sinks) {
      if (remaining <= 0) break;
      const quantity = Math.min(remaining, sink.remaining);
      if (quantity === 0) continue;
      remaining -= quantity;
      sink.remaining -= quantity;
      movedOut.set(source.zone, (movedOut.get(source.zone) ?? 0) + quantity);
      movedIn.set(sink.zone, (movedIn.get(sink.zone) ?? 0) + quantity);
      out.moved({ type: 'moved', key, name, from: source.zone, to: sink.zone, quantity });
    }
  }

  for (const d of deltas) {
    const zoneOut = movedOut.get(d.zone) ?? 0;
    const zoneIn = movedIn.get(d.zone) ?? 0;
    const base = d.before - zoneOut + zoneIn;
    const residual = d.after - base;
    if (residual > 0) {
      out.residual(
        base === 0
          ? { type: 'added', key, name, zone: d.zone, quantity: residual }
          : { type: 'quantity', key, name, zone: d.zone, from: base, to: d.after },
        residual,
      );
    } else if (residual < 0) {
      out.residual(
        d.after === 0
          ? { type: 'removed', key, name, zone: d.zone, quantity: -residual }
          : { type: 'quantity', key, name, zone: d.zone, from: base, to: d.after },
        residual,
      );
    }

    const inBothWithoutMove = d.before > 0 && d.after > 0 && zoneOut === 0 && zoneIn === 0;
    if (inBothWithoutMove && printingsDiffer(d.beforePrintings, d.afterPrintings, d.before === d.after)) {
      out.printing({
        type: 'printing',
        key,
        name,
        zone: d.zone,
        before: d.beforePrintings.map(clonePrinting),
        after: d.afterPrintings.map(clonePrinting),
      });
    }
  }
}

/**
 * With equal quantities the printing multisets (identity and copies) are compared;
 * otherwise only the sets of printing identities, so a plain quantity change in an
 * unchanged printing is not reported as a printing change.
 */
function printingsDiffer(
  before: readonly CanonicalPrinting[],
  after: readonly CanonicalPrinting[],
  compareQuantities: boolean,
): boolean {
  if (before.length === 0 || after.length === 0) return false;
  const beforeCounts = countByIdentity(before);
  const afterCounts = countByIdentity(after);
  if (beforeCounts.size !== afterCounts.size) return true;
  for (const [identity, quantity] of beforeCounts) {
    const other = afterCounts.get(identity);
    if (other === undefined || (compareQuantities && other !== quantity)) return true;
  }
  return false;
}

function countByIdentity(printings: readonly CanonicalPrinting[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of printings) {
    const identity = printingIdentity(p);
    counts.set(identity, (counts.get(identity) ?? 0) + p.quantity);
  }
  return counts;
}

function clonePrinting(p: CanonicalPrinting): CanonicalPrinting {
  const copy: CanonicalPrinting = {
    set: p.set,
    collectorNumber: p.collectorNumber,
    finish: p.finish,
    lang: p.lang,
    quantity: p.quantity,
    ids: { ...p.ids },
  };
  if (p.flags) copy.flags = [...p.flags];
  return copy;
}

/** Accumulates card zone changes together with their statistics. */
class ChangeCollector {
  readonly changes: CardChange[] = [];
  private readonly zones = new Map<ZoneId, ZoneDiffStats>();
  private readonly moves = new Map<string, MoveStats>();
  private printingChanges = 0;

  moved(change: MovedChange): void {
    this.changes.push(change);
    this.zone(change.from).movedOut += change.quantity;
    this.zone(change.to).movedIn += change.quantity;
    const edge = `${change.from}\u0000${change.to}`;
    const stats = getOrCreate(this.moves, edge, () => ({
      from: change.from,
      to: change.to,
      quantity: 0,
      cards: 0,
    }));
    stats.quantity += change.quantity;
    stats.cards += 1;
  }

  /** Records an addition, removal or quantity change; `residual` is the signed copy delta. */
  residual(change: AddedChange | RemovedChange | QuantityChange, residual: number): void {
    this.changes.push(change);
    const stats = this.zone(change.zone);
    if (residual > 0) stats.added += residual;
    else stats.removed -= residual;
  }

  printing(change: PrintingChange): void {
    this.changes.push(change);
    this.printingChanges++;
  }

  stats(tagChanges: number): DiffStats {
    const zones = zoneEntries(this.zones).map(([, stats]) => ({ ...stats }));
    const moves = [...this.moves.values()]
      .map((stats) => ({ ...stats }))
      .sort((a, b) => compareZones(a.from, b.from) || compareZones(a.to, b.to));
    return { zones, moves, printingChanges: this.printingChanges, tagChanges };
  }

  private zone(zone: ZoneId): ZoneDiffStats {
    return getOrCreate(this.zones, zone, () => ({ zone, added: 0, removed: 0, movedIn: 0, movedOut: 0 }));
  }
}

// ---------------------------------------------------------------------------
// Card tags, deck info, commanders
// ---------------------------------------------------------------------------

function diffCardTags(
  before: Readonly<Record<CardKey, readonly string[]>>,
  after: Readonly<Record<CardKey, readonly string[]>>,
  resolveKey: (key: CardKey) => CardKey,
  nameOf: (key: CardKey) => string,
): CardTagsChange[] {
  const beforeTags = tagSets(before, resolveKey);
  const afterTags = tagSets(after, (key) => key);
  const keys = new Set([...beforeTags.keys(), ...afterTags.keys()]);
  const changes: CardTagsChange[] = [];
  for (const key of keys) {
    const { added, removed } = tagDelta(
      beforeTags.get(key) ?? new Set<string>(),
      afterTags.get(key) ?? new Set<string>(),
    );
    if (added.length > 0 || removed.length > 0) {
      changes.push({ type: 'tags', key, name: nameOf(key), added, removed });
    }
  }
  return changes;
}

/** Tags only `after` has and tags only `before` has, each sorted (ordinal). */
function tagDelta(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): { added: string[]; removed: string[] } {
  return {
    added: [...after].filter((tag) => !before.has(tag)).sort(compareStrings),
    removed: [...before].filter((tag) => !after.has(tag)).sort(compareStrings),
  };
}

function tagSets(
  cardTags: Readonly<Record<CardKey, readonly string[]>>,
  resolveKey: (key: CardKey) => CardKey,
): Map<CardKey, Set<string>> {
  const sets = new Map<CardKey, Set<string>>();
  for (const [key, tags] of Object.entries(cardTags)) {
    const set = getOrCreate(sets, resolveKey(key), () => new Set<string>());
    for (const tag of tags) set.add(tag);
  }
  return sets;
}

function diffDeckInfo(before: DeckInfo, after: DeckInfo): DeckInfoChange[] {
  const changes: DeckInfoChange[] = [];
  for (const field of ['name', 'format', 'description'] as const) {
    if (before[field] !== after[field]) changes.push({ field, before: before[field], after: after[field] });
  }
  const { added, removed } = tagDelta(new Set(before.tags), new Set(after.tags));
  if (added.length > 0 || removed.length > 0) {
    changes.push({ field: 'tags', before: [...before.tags], after: [...after.tags], added, removed });
  }
  return changes;
}

function commanderSummary(
  before: CanonicalSnapshot,
  after: CanonicalSnapshot,
  changes: readonly CardChange[],
): CommanderSummary {
  return {
    before: commanderNames(before),
    after: commanderNames(after),
    changed: changes.some(
      (change) => STRATEGIC_CHANGE_TYPES.has(change.type) && changeTouchesZone(change, 'commanders'),
    ),
  };
}
