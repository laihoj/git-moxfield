/**
 * Property-based tests of the semantic diff over random canonical snapshots drawn from
 * a small card pool, so collisions (same card in several zones, moves, quantity and
 * printing changes, renames) are frequent.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildSnapshot, type CardSpec, type SnapshotSpec } from '@tests/support/builders';

import { stableStringify } from '../canonical';
import { cardKey } from '../card-key';
import type { CanonicalSnapshot } from '../model';
import type { ZoneId } from '../zones';
import { compareCardChanges, diffSnapshots } from './deck-diff';
import { STRATEGIC_CHANGE_TYPES, type DeckDiff } from './types';

const RUNS = { seed: 20261009, numRuns: 300 } as const;

const ZONES: readonly ZoneId[] = ['commanders', 'mainboard', 'sideboard', 'considering', 'other:wishboard'];

/** `Old Name` and `New Name` share a Moxfield id, so they reconcile as a rename when unambiguous. */
const POOL: readonly { name: string; moxfield: string }[] = [
  { name: 'Island', moxfield: 'u-island' },
  { name: 'Sol Ring', moxfield: 'u-sol-ring' },
  { name: 'Dress Down', moxfield: 'u-dress-down' },
  { name: 'Brainstorm', moxfield: 'u-brainstorm' },
  { name: 'Final Fortune', moxfield: 'u-final-fortune' },
  { name: 'Old Name', moxfield: 'u-renamed' },
  { name: 'New Name', moxfield: 'u-renamed' },
];

const PRINTINGS = [
  { set: 'aaa', collectorNumber: '1' },
  { set: 'bbb', collectorNumber: '2', finish: 'foil' },
] as const;

const entryArb = fc
  .record({
    zone: fc.constantFrom(...ZONES),
    card: fc.constantFrom(...POOL),
    copiesA: fc.nat({ max: 3 }),
    copiesB: fc.nat({ max: 2 }),
  })
  .filter(({ copiesA, copiesB }) => copiesA + copiesB > 0);

const snapshotArb: fc.Arbitrary<CanonicalSnapshot> = fc
  .record({
    entries: fc.array(entryArb, { maxLength: 14 }),
    tags: fc.array(fc.tuple(fc.constantFrom(...POOL), fc.subarray(['combo', 'hate', 'stax'])), {
      maxLength: 4,
    }),
    name: fc.constantFrom('Deck A', 'Deck B'),
    primer: fc.constantFrom(null, '', 'a\n', 'a\nb\n', 'b\nc\n'),
  })
  .map(({ entries, tags, name, primer }) => {
    const zones: Partial<Record<ZoneId, CardSpec[]>> = {};
    for (const { zone, card, copiesA, copiesB } of entries) {
      const printings = [
        { ...PRINTINGS[0], quantity: copiesA },
        { ...PRINTINGS[1], quantity: copiesB },
      ].filter((p) => p.quantity > 0);
      (zones[zone] ??= []).push({ name: card.name, ids: { moxfield: card.moxfield }, printings });
    }
    const spec: SnapshotSpec = {
      deck: { name },
      zones,
      cardTags: Object.fromEntries(tags.map(([card, cardTags]) => [card.name, cardTags])),
      primer,
    };
    return buildSnapshot(spec);
  });

type QuantityMap = Map<string, number>;

const slot = (key: string, zone: ZoneId): string => `${key}|${zone}`;

function quantityMap(snapshot: CanonicalSnapshot, resolve: (key: string) => string = (k) => k): QuantityMap {
  const map: QuantityMap = new Map();
  for (const [zone, cards] of Object.entries(snapshot.zones) as [
    ZoneId,
    { key: string; quantity: number }[],
  ][]) {
    for (const card of cards) {
      const id = slot(resolve(card.key), zone);
      map.set(id, (map.get(id) ?? 0) + card.quantity);
    }
  }
  return map;
}

function renameResolver(diff: DeckDiff): (key: string) => string {
  const renames = new Map<string, string>();
  for (const change of diff.changes) {
    if (change.type === 'renamed') renames.set(cardKey(change.previousName), change.key);
  }
  return (key) => renames.get(key) ?? key;
}

/** Applies the strategic changes of `diff` to `before`'s quantities, checking each step. */
function applyCardChanges(diff: DeckDiff, before: QuantityMap): QuantityMap {
  const map = new Map(before);
  const get = (key: string, zone: ZoneId): number => map.get(slot(key, zone)) ?? 0;
  const set = (key: string, zone: ZoneId, quantity: number): void => {
    expect(quantity).toBeGreaterThanOrEqual(0);
    if (quantity === 0) map.delete(slot(key, zone));
    else map.set(slot(key, zone), quantity);
  };
  for (const change of diff.changes) {
    switch (change.type) {
      case 'moved':
        set(change.key, change.from, get(change.key, change.from) - change.quantity);
        set(change.key, change.to, get(change.key, change.to) + change.quantity);
        break;
      case 'added':
        expect(get(change.key, change.zone)).toBe(0);
        set(change.key, change.zone, change.quantity);
        break;
      case 'removed':
        expect(get(change.key, change.zone)).toBe(change.quantity);
        set(change.key, change.zone, 0);
        break;
      case 'quantity':
        expect(get(change.key, change.zone)).toBe(change.from);
        set(change.key, change.zone, change.to);
        break;
      default:
        break;
    }
  }
  return map;
}

function sortedEntries(map: QuantityMap): [string, number][] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

describe('diffSnapshots properties', () => {
  it('(a) applying the card changes to before yields exactly after', () => {
    fc.assert(
      fc.property(snapshotArb, snapshotArb, (before, after) => {
        const diff = diffSnapshots(before, after);
        const resolve = renameResolver(diff);
        const applied = applyCardChanges(diff, quantityMap(before, resolve));
        expect(sortedEntries(applied)).toEqual(sortedEntries(quantityMap(after)));
      }),
      RUNS,
    );
  });

  it('(b) a snapshot compared with itself is empty', () => {
    fc.assert(
      fc.property(snapshotArb, (snapshot) => {
        const diff = diffSnapshots(snapshot, structuredClone(snapshot));
        expect(diff.changes).toEqual([]);
        expect(diff.deck).toEqual([]);
        expect(diff.isEmpty).toBe(true);
        expect(diff.hasCardChanges).toBe(false);
        expect(diff.onlyCosmetic).toBe(false);
        expect(diff.commanders.changed).toBe(false);
        expect(diff.stats).toEqual({ zones: [], moves: [], printingChanges: 0, tagChanges: 0, renames: 0 });
      }),
      RUNS,
    );
  });

  it('(c) per card, moved copies equal min(total decrease, total increase)', () => {
    fc.assert(
      fc.property(snapshotArb, snapshotArb, (before, after) => {
        const diff = diffSnapshots(before, after);
        const beforeMap = quantityMap(before, renameResolver(diff));
        const afterMap = quantityMap(after);
        const decrease = new Map<string, number>();
        const increase = new Map<string, number>();
        for (const id of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
          const key = id.slice(0, id.indexOf('|'));
          const delta = (afterMap.get(id) ?? 0) - (beforeMap.get(id) ?? 0);
          if (delta < 0) decrease.set(key, (decrease.get(key) ?? 0) - delta);
          if (delta > 0) increase.set(key, (increase.get(key) ?? 0) + delta);
        }
        const moved = new Map<string, number>();
        for (const change of diff.changes) {
          if (change.type === 'moved') moved.set(change.key, (moved.get(change.key) ?? 0) + change.quantity);
        }
        for (const key of new Set([...decrease.keys(), ...increase.keys()])) {
          expect(moved.get(key) ?? 0).toBe(Math.min(decrease.get(key) ?? 0, increase.get(key) ?? 0));
        }
        // A card never has both an unexplained addition and an unexplained removal of copies.
        const grows = new Set<string>();
        const shrinks = new Set<string>();
        for (const change of diff.changes) {
          if (change.type === 'added' || (change.type === 'quantity' && change.to > change.from)) {
            grows.add(change.key);
          }
          if (change.type === 'removed' || (change.type === 'quantity' && change.to < change.from)) {
            shrinks.add(change.key);
          }
        }
        for (const key of grows) expect(shrinks.has(key)).toBe(false);
      }),
      RUNS,
    );
  });

  it('(d) is deterministic and does not mutate its inputs', () => {
    fc.assert(
      fc.property(snapshotArb, snapshotArb, (before, after) => {
        const beforeJson = stableStringify(before);
        const afterJson = stableStringify(after);
        const first = diffSnapshots(before, after);
        const second = diffSnapshots(structuredClone(before), structuredClone(after));
        expect(stableStringify(second)).toBe(stableStringify(first));
        expect(stableStringify(before)).toBe(beforeJson);
        expect(stableStringify(after)).toBe(afterJson);
      }),
      RUNS,
    );
  });

  it('(e) changes are well-formed, strictly ordered and consistent with stats and flags', () => {
    fc.assert(
      fc.property(snapshotArb, snapshotArb, (before, after) => {
        const diff = diffSnapshots(before, after);
        for (let i = 1; i < diff.changes.length; i++) {
          const previous = diff.changes[i - 1];
          const current = diff.changes[i];
          if (previous && current) expect(compareCardChanges(previous, current)).toBeLessThan(0);
        }

        const zoneTotals = new Map<
          ZoneId,
          { added: number; removed: number; movedIn: number; movedOut: number }
        >();
        const totals = (zone: ZoneId) => {
          let entry = zoneTotals.get(zone);
          if (!entry) zoneTotals.set(zone, (entry = { added: 0, removed: 0, movedIn: 0, movedOut: 0 }));
          return entry;
        };
        for (const change of diff.changes) {
          switch (change.type) {
            case 'moved':
              expect(change.quantity).toBeGreaterThan(0);
              expect(change.from).not.toBe(change.to);
              totals(change.from).movedOut += change.quantity;
              totals(change.to).movedIn += change.quantity;
              break;
            case 'added':
              expect(change.quantity).toBeGreaterThan(0);
              totals(change.zone).added += change.quantity;
              break;
            case 'removed':
              expect(change.quantity).toBeGreaterThan(0);
              totals(change.zone).removed += change.quantity;
              break;
            case 'quantity':
              expect(change.from).toBeGreaterThan(0);
              expect(change.to).toBeGreaterThan(0);
              expect(change.from).not.toBe(change.to);
              if (change.to > change.from) totals(change.zone).added += change.to - change.from;
              else totals(change.zone).removed += change.from - change.to;
              break;
            default:
              break;
          }
        }
        expect(diff.stats.zones).toEqual(
          [...zoneTotals.entries()]
            .map(([zone, counts]) => ({ zone, ...counts }))
            .sort((a, b) => ZONES.indexOf(a.zone) - ZONES.indexOf(b.zone)),
        );
        expect(diff.stats.printingChanges).toBe(diff.changes.filter((c) => c.type === 'printing').length);
        expect(diff.stats.renames).toBe(diff.changes.filter((c) => c.type === 'renamed').length);
        expect(diff.stats.tagChanges).toBe(diff.changes.filter((c) => c.type === 'tags').length);

        const strategic = diff.changes.some((c) => STRATEGIC_CHANGE_TYPES.has(c.type));
        const primerChanged = diff.primer.status === 'changed' || diff.primer.status === 'captured';
        expect(diff.hasCardChanges).toBe(strategic);
        expect(diff.isEmpty).toBe(diff.changes.length === 0 && diff.deck.length === 0 && !primerChanged);
        expect(diff.onlyCosmetic).toBe(
          !diff.isEmpty && !strategic && diff.deck.length === 0 && !primerChanged,
        );
        if (diff.isEmpty) expect(diff.commanders.changed).toBe(false);
      }),
      RUNS,
    );
  });

  it('(f) printing changes only concern zones holding the card on both sides without a move', () => {
    fc.assert(
      fc.property(snapshotArb, snapshotArb, (before, after) => {
        const diff = diffSnapshots(before, after);
        const beforeMap = quantityMap(before, renameResolver(diff));
        const afterMap = quantityMap(after);
        for (const change of diff.changes) {
          if (change.type !== 'printing') continue;
          expect(beforeMap.get(slot(change.key, change.zone)) ?? 0).toBeGreaterThan(0);
          expect(afterMap.get(slot(change.key, change.zone)) ?? 0).toBeGreaterThan(0);
          const involvedInMove = diff.changes.some(
            (c) =>
              c.type === 'moved' && c.key === change.key && (c.from === change.zone || c.to === change.zone),
          );
          expect(involvedInMove).toBe(false);
        }
      }),
      RUNS,
    );
  });
});
