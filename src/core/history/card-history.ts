/**
 * Card history derivation (`git log -- <card>`).
 *
 * A card's history is derived from the deck's versions, never stored: the caller
 * provides one {@link CardVersionPoint} per version, oldest → newest, optionally
 * followed by a single uncommitted working-state point (`sequence: null`).
 *
 * Each entry is classified relative to the previous point:
 *
 * - first point: `first-seen` when the card is present, otherwise `unchanged`;
 * - absent → present: `added` the first time the card appears in the examined range,
 *   `restored` when it had been present at an earlier point;
 * - present → absent: `removed`;
 * - present → present with a different zone set: `restored` when the card enters at
 *   least one zone it had occupied at an earlier point (and therefore left), otherwise
 *   `moved`;
 * - same zone set, different quantities: `quantity`;
 * - otherwise `unchanged`.
 *
 * "Restored" is applied literally and symmetrically for every zone, played or not:
 * mainboard → considering → mainboard → considering is `moved`, `restored`, `restored`,
 * because the last step returns the card to considering, which it had occupied and left.
 *
 * A card keeps its history across renames the semantic diff reconciles (a key change
 * with a shared stable id, e.g. an oracle rename): {@link traceCardKeys} resolves the
 * card's key at every point, and a point where the key changed carries `renamedFrom`.
 * A rename is cosmetic, as in the diff: it is listed among the changes but never
 * classified as a removal or an addition.
 *
 * Pure and deterministic; input points are never mutated.
 */
import { findCard, snapshotZones } from '../canonical';
import { renamedKeys } from '../diff/deck-diff';
import type { CanonicalSnapshot, CardKey } from '../model';
import { compareZones, isPlayedZone, type ZoneId } from '../zones';
import type {
  CardHistory,
  CardHistoryEntry,
  CardHistoryRun,
  CardTransition,
  CardVersionPoint,
  ZoneQuantity,
} from './types';

export interface DeriveCardHistoryInput {
  key: CardKey;
  /** Most recent known display name; copied to {@link CardHistory.name}. */
  name: string;
  /**
   * One point per examined version, oldest → newest, optionally followed by one
   * working-state point (`sequence: null`). Zone lists need not be canonical: they are
   * re-sorted, zero quantities dropped and duplicate zones merged.
   */
  points: readonly CardVersionPoint[];
}

/** A deck version with its full snapshot, as accepted by {@link cardPointsFromSnapshots}. */
export interface VersionedSnapshot {
  /** Commit id, or `null` for the uncommitted working state. */
  commitId: string | null;
  /** Version number, or `null` for the uncommitted working state. */
  sequence: number | null;
  at: string;
  message: string;
  snapshot: CanonicalSnapshot;
}

type RestoredZone = NonNullable<CardHistoryEntry['restoredFrom']>[number];

/** Derives the history of one card from its per-version states. */
export function deriveCardHistory(input: DeriveCardHistoryInput): CardHistory {
  const entries: CardHistoryEntry[] = [];
  /** Zone → sequence of the latest point so far in which the card was in that zone. */
  const lastSequenceInZone = new Map<ZoneId, number | null>();
  let seenBefore = false;
  let previous: ZoneQuantity[] = [];

  for (const point of input.points) {
    const zones = normalizeZoneQuantities(point.zones);
    const returnedTo = zonesReturnedTo(previous, zones, lastSequenceInZone);
    const transition = classifyTransition({
      isFirst: entries.length === 0,
      seenBefore,
      previous,
      zones,
      returnedTo,
    });

    const entry: CardHistoryEntry = {
      commitId: point.commitId,
      sequence: point.sequence,
      at: point.at,
      message: point.message,
      zones,
      transition,
      previousZones: copyZones(previous),
    };
    if (transition === 'restored') entry.restoredFrom = returnedTo;
    if (point.renamedFrom) entry.renamedFrom = { key: point.renamedFrom.key, name: point.renamedFrom.name };
    entries.push(entry);

    for (const { zone } of zones) lastSequenceInZone.set(zone, point.sequence);
    if (zones.length > 0) seenBefore = true;
    previous = zones;
  }

  const committed = entries.filter((entry) => entry.sequence !== null);
  const isPresent = (entry: CardHistoryEntry): boolean => entry.zones.length > 0;

  return {
    key: input.key,
    name: input.name,
    entries,
    changes: entries.filter((entry) => entry.transition !== 'unchanged' || entry.renamedFrom !== undefined),
    runs: compressRuns(entries),
    summary: {
      firstSeenSequence: committed.find(isPresent)?.sequence ?? null,
      lastSeenSequence: committed.findLast(isPresent)?.sequence ?? null,
      currentZones: copyZones(entries.at(-1)?.zones ?? []),
      versionsInPlayedZones: committed.filter((entry) => inPlayedZone(entry.zones)).length,
      timesCut: entries.filter(isCut).length,
      // A return to Considering or the sideboard that takes the card out of play is a
      // cut, not a restore, even though its timeline entry reads "Restored to Considering".
      timesRestored: entries.filter((entry) => entry.transition === 'restored' && !isCut(entry)).length,
    },
  };
}

/** The card left every played zone (cut to Considering/the sideboard, or removed). */
function isCut(entry: CardHistoryEntry): boolean {
  return inPlayedZone(entry.previousZones) && !inPlayedZone(entry.zones);
}

/**
 * Extracts one card's {@link CardVersionPoint}s from full snapshots, preserving the
 * order and version metadata of `versions`. The card is followed across reconciled
 * renames (see {@link traceCardKeys}), so `key` may be any of its names; a point's
 * zones are empty when the snapshot does not contain the card.
 */
export function cardPointsFromSnapshots(
  key: CardKey,
  versions: readonly VersionedSnapshot[],
): CardVersionPoint[] {
  const snapshotAt = (index: number): CanonicalSnapshot | undefined => versions[index]?.snapshot;
  const zonesAt = (cardKey: CardKey, index: number): ZoneQuantity[] => {
    const snapshot = snapshotAt(index);
    if (!snapshot) return [];
    return snapshotZones(snapshot).flatMap((zone) => {
      const card = findCard(snapshot, zone, cardKey);
      return card ? [{ zone, quantity: card.quantity }] : [];
    });
  };
  const keys = traceCardKeys({
    key,
    length: versions.length,
    contains: (cardKey, index) => zonesAt(cardKey, index).length > 0,
    renames: (index) => {
      const before = snapshotAt(index - 1);
      const after = snapshotAt(index);
      return before && after ? renamedKeys(before, after) : new Map<CardKey, CardKey>();
    },
  });

  return versions.map(({ commitId, sequence, at, message }, index) => {
    const pointKey = keys[index] ?? key;
    const point: CardVersionPoint = { commitId, sequence, at, message, zones: zonesAt(pointKey, index) };
    const previousKey = keys[index - 1];
    if (previousKey !== undefined && previousKey !== pointKey) {
      point.renamedFrom = { key: previousKey, name: cardNameIn(snapshotAt(index - 1), previousKey) };
    }
    return point;
  });
}

export interface TraceCardKeysInput {
  /** The key the history was requested for: any name the card had. */
  key: CardKey;
  /** Number of points (versions oldest → newest, optionally the working state). */
  length: number;
  /** Whether the point at `index` contains the card with key `key` in any zone. */
  contains: (key: CardKey, index: number) => boolean;
  /**
   * Renames from the point at `index - 1` to the point at `index` (old key → new key),
   * as {@link renamedKeys} reconciles them. Called only where a tracked key appears or
   * disappears, so callers can load snapshots for these boundaries alone.
   */
  renames: (index: number) => ReadonlyMap<CardKey, CardKey>;
}

/**
 * The card's key at every point, following the renames the semantic diff reconciles,
 * so a renamed card has one continuous history under each of its names.
 *
 * Tracing starts at the newest point containing `key` and walks both ways. Walking
 * forward, where the tracked key disappears and a rename maps it to a key present at
 * that point, the new key is tracked from there on; walking backward, where the tracked
 * key appears and a rename maps a key present at the previous point to it, the old key
 * is tracked before it. Chains of renames are followed. A removal followed later by an
 * addition under another name is never joined, just as the diff does not reconcile it.
 * When `key` is in no point, every point keeps `key`.
 */
export function traceCardKeys(input: TraceCardKeysInput): CardKey[] {
  const { key, length, contains, renames } = input;
  const keys = Array.from({ length }, () => key);
  let anchor = length - 1;
  while (anchor >= 0 && !contains(key, anchor)) anchor--;
  if (anchor < 0) return keys;

  let current = key;
  for (let index = anchor + 1; index < length; index++) {
    if (!contains(current, index) && contains(current, index - 1)) {
      const next = renames(index).get(current);
      if (next !== undefined && contains(next, index)) current = next;
    }
    keys[index] = current;
  }

  current = key;
  for (let index = anchor - 1; index >= 0; index--) {
    if (!contains(current, index) && contains(current, index + 1)) {
      for (const [from, to] of renames(index + 1)) {
        if (to === current && contains(from, index)) {
          current = from;
          break;
        }
      }
    }
    keys[index] = current;
  }
  return keys;
}

/** Display name of a card in a snapshot (first zone in canonical order), or its key. */
function cardNameIn(snapshot: CanonicalSnapshot | undefined, key: CardKey): string {
  if (snapshot) {
    for (const zone of snapshotZones(snapshot)) {
      const card = findCard(snapshot, zone, key);
      if (card) return card.name;
    }
  }
  return key;
}

/** Canonical zone list: positive quantities only, one entry per zone, canonical zone order. */
function normalizeZoneQuantities(zones: readonly ZoneQuantity[]): ZoneQuantity[] {
  const totals = new Map<ZoneId, number>();
  for (const { zone, quantity } of zones) {
    if (quantity > 0) totals.set(zone, (totals.get(zone) ?? 0) + quantity);
  }
  return [...totals].sort(([a], [b]) => compareZones(a, b)).map(([zone, quantity]) => ({ zone, quantity }));
}

/** Zones the card enters at this point that it had occupied at some earlier point. */
function zonesReturnedTo(
  previous: readonly ZoneQuantity[],
  zones: readonly ZoneQuantity[],
  lastSequenceInZone: ReadonlyMap<ZoneId, number | null>,
): RestoredZone[] {
  const previousZoneIds = new Set(previous.map(({ zone }) => zone));
  const returnedTo: RestoredZone[] = [];
  for (const { zone } of zones) {
    if (previousZoneIds.has(zone)) continue;
    const lastSequence = lastSequenceInZone.get(zone);
    if (lastSequence !== undefined) returnedTo.push({ zone, lastSequence });
  }
  return returnedTo;
}

function classifyTransition(state: {
  isFirst: boolean;
  seenBefore: boolean;
  previous: readonly ZoneQuantity[];
  zones: readonly ZoneQuantity[];
  returnedTo: readonly RestoredZone[];
}): CardTransition {
  const { isFirst, seenBefore, previous, zones, returnedTo } = state;
  const present = zones.length > 0;
  if (isFirst) return present ? 'first-seen' : 'unchanged';
  if (previous.length === 0) {
    if (!present) return 'unchanged';
    return seenBefore ? 'restored' : 'added';
  }
  if (!present) return 'removed';
  if (!sameZoneSet(previous, zones)) return returnedTo.length > 0 ? 'restored' : 'moved';
  return sameState(previous, zones) ? 'unchanged' : 'quantity';
}

/**
 * Groups consecutive entries with identical zone states (quantities included). A
 * rename starts a new run, so the run's first entry shows it.
 */
function compressRuns(entries: readonly CardHistoryEntry[]): CardHistoryRun[] {
  const runs: CardHistoryRun[] = [];
  for (const entry of entries) {
    const current = runs.at(-1);
    if (current && entry.renamedFrom === undefined && sameState(current.zones, entry.zones)) {
      current.last = entry;
      current.length += 1;
    } else {
      runs.push({ zones: copyZones(entry.zones), first: entry, last: entry, length: 1 });
    }
  }
  return runs;
}

function sameZoneSet(a: readonly ZoneQuantity[], b: readonly ZoneQuantity[]): boolean {
  return a.length === b.length && a.every(({ zone }, i) => zone === b[i]?.zone);
}

function sameState(a: readonly ZoneQuantity[], b: readonly ZoneQuantity[]): boolean {
  return sameZoneSet(a, b) && a.every(({ quantity }, i) => quantity === b[i]?.quantity);
}

function inPlayedZone(zones: readonly ZoneQuantity[]): boolean {
  return zones.some(({ zone }) => isPlayedZone(zone));
}

/** Fresh copies so that entries, runs and the summary never alias each other's arrays. */
function copyZones(zones: readonly ZoneQuantity[]): ZoneQuantity[] {
  return zones.map(({ zone, quantity }) => ({ zone, quantity }));
}
