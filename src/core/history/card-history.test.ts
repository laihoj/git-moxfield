import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildSnapshot, type SnapshotSpec } from '@tests/support/builders';

import { isPlayedZone, type ZoneId } from '../zones';
import {
  cardPointsFromSnapshots,
  deriveCardHistory,
  traceCardKeys,
  type VersionedSnapshot,
} from './card-history';
import type { CardHistory, CardHistoryEntry, CardTransition, CardVersionPoint, ZoneQuantity } from './types';

const KEY = 'dress down';
const NAME = 'Dress Down';

type ZoneSpec = Partial<Record<ZoneId, number>>;

/** A committed version point `v<sequence>` with the given zone quantities. */
function v(sequence: number, zones: ZoneSpec = {}): CardVersionPoint {
  return {
    commitId: `commit-${sequence}`,
    sequence,
    at: `2026-01-${String(sequence).padStart(2, '0')}T00:00:00.000Z`,
    message: `Version ${sequence}`,
    zones: toZoneList(zones),
  };
}

/** The uncommitted working-state point. */
function working(zones: ZoneSpec = {}): CardVersionPoint {
  return {
    commitId: null,
    sequence: null,
    at: '2026-02-01T00:00:00.000Z',
    message: 'Current Moxfield deck',
    zones: toZoneList(zones),
  };
}

function toZoneList(zones: ZoneSpec): ZoneQuantity[] {
  return Object.entries(zones).flatMap(([zone, quantity]) =>
    quantity === undefined ? [] : [{ zone: zone as ZoneId, quantity }],
  );
}

function history(points: CardVersionPoint[]): CardHistory {
  return deriveCardHistory({ key: KEY, name: NAME, points });
}

function transitions(h: CardHistory): CardTransition[] {
  return h.entries.map((entry) => entry.transition);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('deriveCardHistory', () => {
  it('returns an empty history for zero points', () => {
    expect(history([])).toEqual({
      key: KEY,
      name: NAME,
      entries: [],
      changes: [],
      runs: [],
      summary: {
        firstSeenSequence: null,
        lastSeenSequence: null,
        currentZones: [],
        versionCount: 0,

        versionsPresent: 0,

        versionsInPlayedZones: 0,
        timesCut: 0,
        timesRestored: 0,
      },
    });
  });

  it('includes every examined version for a card that never appears', () => {
    const h = history([v(1), v(2), working()]);

    expect(transitions(h)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(h.entries.map((e) => e.zones)).toEqual([[], [], []]);
    expect(h.changes).toEqual([]);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({ zones: [], length: 3, first: h.entries[0], last: h.entries[2] });
    expect(h.summary).toEqual({
      firstSeenSequence: null,
      lastSeenSequence: null,
      currentZones: [],
      versionCount: 2,

      versionsPresent: 0,

      versionsInPlayedZones: 0,
      timesCut: 0,
      timesRestored: 0,
    });
  });

  it('handles a card that exists only in the working state', () => {
    const h = history([working({ mainboard: 1 })]);

    expect(h.entries).toEqual([
      {
        ...working({ mainboard: 1 }),
        transition: 'first-seen',
        previousZones: [],
      },
    ]);
    expect(h.changes).toEqual(h.entries);
    expect(h.summary).toEqual({
      firstSeenSequence: null,
      lastSeenSequence: null,
      currentZones: [{ zone: 'mainboard', quantity: 1 }],
      versionCount: 0,

      versionsPresent: 0,

      versionsInPlayedZones: 0,
      timesCut: 0,
      timesRestored: 0,
    });
  });

  it('classifies a card that first appears in the working state as added', () => {
    const h = history([v(1), v(2), working({ considering: 1 })]);

    expect(transitions(h)).toEqual(['unchanged', 'unchanged', 'added']);
    expect(h.summary.firstSeenSequence).toBeNull();
    expect(h.summary.lastSeenSequence).toBeNull();
    expect(h.summary.currentZones).toEqual([{ zone: 'considering', quantity: 1 }]);
  });

  it('reproduces the Dress Down example from the spec', () => {
    const points = [
      v(19, { mainboard: 1 }),
      v(20, { mainboard: 1 }),
      v(21, { considering: 1 }),
      v(28, { mainboard: 1 }),
      v(31, { considering: 1 }),
      v(44, { mainboard: 1 }),
    ];
    const h = history(points);

    expect(
      h.entries.map(({ sequence, transition, previousZones, restoredFrom }) => ({
        sequence,
        transition,
        previous: previousZones.map((z) => z.zone),
        restoredFrom,
      })),
    ).toEqual([
      { sequence: 19, transition: 'first-seen', previous: [], restoredFrom: undefined },
      { sequence: 20, transition: 'unchanged', previous: ['mainboard'], restoredFrom: undefined },
      { sequence: 21, transition: 'moved', previous: ['mainboard'], restoredFrom: undefined },
      {
        sequence: 28,
        transition: 'restored',
        previous: ['considering'],
        restoredFrom: [{ zone: 'mainboard', lastSequence: 20 }],
      },
      {
        sequence: 31,
        transition: 'restored',
        previous: ['mainboard'],
        restoredFrom: [{ zone: 'considering', lastSequence: 21 }],
      },
      {
        sequence: 44,
        transition: 'restored',
        previous: ['considering'],
        restoredFrom: [{ zone: 'mainboard', lastSequence: 28 }],
      },
    ]);
    expect(h.changes.map((e) => e.sequence)).toEqual([19, 21, 28, 31, 44]);
    expect(
      h.runs.map((r) => [r.zones.map((z) => z.zone), r.first.sequence, r.last.sequence, r.length]),
    ).toEqual([
      [['mainboard'], 19, 20, 2],
      [['considering'], 21, 21, 1],
      [['mainboard'], 28, 28, 1],
      [['considering'], 31, 31, 1],
      [['mainboard'], 44, 44, 1],
    ]);
    // v31 returns the card to Considering ("restored" in the timeline), but that is a
    // cut, not a restore: the card was cut twice and brought back twice.
    expect(h.summary).toEqual({
      firstSeenSequence: 19,
      lastSeenSequence: 44,
      currentZones: [{ zone: 'mainboard', quantity: 1 }],
      versionCount: 6,

      versionsPresent: 6,

      versionsInPlayedZones: 4,
      timesCut: 2,
      timesRestored: 2,
    });
  });

  it('never counts one transition as both a cut and a restore', () => {
    const h = history([
      v(1, { mainboard: 1 }),
      v(2, { considering: 1 }),
      v(3, { mainboard: 1 }),
      v(4, { considering: 1 }),
    ]);

    expect(transitions(h)).toEqual(['first-seen', 'moved', 'restored', 'restored']);
    expect(h.summary).toMatchObject({ timesCut: 2, timesRestored: 1 });
  });

  it('records the last earlier version in the zone as lastSequence', () => {
    const h = history([
      v(1, { mainboard: 1 }),
      v(2, { mainboard: 1 }),
      v(3, { mainboard: 1 }),
      v(4, { sideboard: 1 }),
      v(5, { sideboard: 1 }),
      v(6, { mainboard: 1 }),
    ]);

    expect(h.entries[5]).toMatchObject({
      sequence: 6,
      transition: 'restored',
      restoredFrom: [{ zone: 'mainboard', lastSequence: 3 }],
    });
  });

  it('distinguishes first-seen, added, removed and restored deck membership', () => {
    const h = history([
      v(1),
      v(2, { mainboard: 1 }),
      v(3),
      v(4),
      v(5, { mainboard: 1 }),
      v(6),
      v(7, { sideboard: 1 }),
    ]);

    expect(transitions(h)).toEqual([
      'unchanged',
      'added',
      'removed',
      'unchanged',
      'restored',
      'removed',
      'restored',
    ]);
    expect(h.entries[1]?.restoredFrom).toBeUndefined();
    expect(h.entries[4]?.restoredFrom).toEqual([{ zone: 'mainboard', lastSequence: 2 }]);
    // Back in the deck, but in a zone it never occupied: deck membership is restored,
    // no zone is.
    expect(h.entries[6]?.restoredFrom).toEqual([]);
    expect(h.summary.firstSeenSequence).toBe(2);
    expect(h.summary.lastSeenSequence).toBe(7);
    expect(h.summary.timesCut).toBe(2);
    expect(h.summary.timesRestored).toBe(2);
  });

  it('classifies zone changes without a return as moves', () => {
    const h = history([
      v(1, { commanders: 1 }),
      v(2, { mainboard: 1 }),
      v(3, { mainboard: 1, sideboard: 1 }),
    ]);

    expect(transitions(h)).toEqual(['first-seen', 'moved', 'moved']);
    expect(h.entries[2]?.previousZones).toEqual([{ zone: 'mainboard', quantity: 1 }]);
  });

  it('treats leaving one of several zones as a move', () => {
    const h = history([v(1, { mainboard: 1, considering: 1 }), v(2, { mainboard: 1 })]);

    expect(transitions(h)).toEqual(['first-seen', 'moved']);
    expect(h.summary.timesCut).toBe(0);
  });

  it('restores when re-entering a former zone even while staying in another', () => {
    const h = history([
      v(1, { mainboard: 2 }),
      v(2, { mainboard: 1, sideboard: 1 }),
      v(3, { mainboard: 1 }),
      v(4, { mainboard: 1, sideboard: 1 }),
    ]);

    expect(transitions(h)).toEqual(['first-seen', 'moved', 'moved', 'restored']);
    expect(h.entries[3]?.restoredFrom).toEqual([{ zone: 'sideboard', lastSequence: 2 }]);
  });

  it('lists every zone returned to, in canonical zone order', () => {
    const h = history([
      v(1, { mainboard: 1, considering: 1 }),
      v(2, { sideboard: 1 }),
      v(3, { considering: 1, mainboard: 1, sideboard: 1 }),
    ]);

    expect(h.entries[2]?.restoredFrom).toEqual([
      { zone: 'mainboard', lastSequence: 1 },
      { zone: 'considering', lastSequence: 1 },
    ]);
  });

  it('classifies quantity changes in the same zones', () => {
    const h = history([
      v(1, { mainboard: 3 }),
      v(2, { mainboard: 4 }),
      v(3, { mainboard: 4 }),
      v(4, { mainboard: 1, sideboard: 1 }),
      v(5, { mainboard: 2, sideboard: 1 }),
    ]);

    expect(transitions(h)).toEqual(['first-seen', 'quantity', 'unchanged', 'moved', 'quantity']);
    expect(h.runs.map((r) => [r.zones, r.length])).toEqual([
      [[{ zone: 'mainboard', quantity: 3 }], 1],
      [[{ zone: 'mainboard', quantity: 4 }], 2],
      [
        [
          { zone: 'mainboard', quantity: 1 },
          { zone: 'sideboard', quantity: 1 },
        ],
        1,
      ],
      [
        [
          { zone: 'mainboard', quantity: 2 },
          { zone: 'sideboard', quantity: 1 },
        ],
        1,
      ],
    ]);
  });

  it('normalizes zone lists: canonical order, zero quantities dropped, duplicates merged', () => {
    const h = history([
      {
        ...v(1),
        zones: [
          { zone: 'considering', quantity: 1 },
          { zone: 'other:foo', quantity: 1 },
          { zone: 'sideboard', quantity: 0 },
          { zone: 'mainboard', quantity: 1 },
          { zone: 'commanders', quantity: 1 },
          { zone: 'mainboard', quantity: 2 },
        ],
      },
      { ...v(2), zones: [{ zone: 'sideboard', quantity: 0 }] },
    ]);

    expect(h.entries[0]?.zones).toEqual([
      { zone: 'commanders', quantity: 1 },
      { zone: 'mainboard', quantity: 3 },
      { zone: 'considering', quantity: 1 },
      { zone: 'other:foo', quantity: 1 },
    ]);
    expect(h.entries[1]).toMatchObject({ zones: [], transition: 'removed' });
  });

  it('treats differently ordered but identical zone lists as unchanged', () => {
    const h = history([
      { ...v(1), zones: toZoneList({ sideboard: 1, mainboard: 2 }) },
      { ...v(2), zones: toZoneList({ mainboard: 2, sideboard: 1 }) },
    ]);

    expect(transitions(h)).toEqual(['first-seen', 'unchanged']);
  });

  it('counts cuts only when leaving every played zone', () => {
    const h = history([
      v(1, { commanders: 1 }),
      v(2, { mainboard: 1 }), // played → played: not a cut
      v(3, { considering: 1 }), // cut to considering
      v(4, { sideboard: 1 }), // not played → not played
      v(5), // removed from a non-played zone: not a cut
      v(6, { mainboard: 1, sideboard: 1 }),
      v(7, { sideboard: 1 }), // cut, still tracked in the sideboard
      v(8, { signatureSpells: 1 }),
      working(), // removed in the working state: counts like any other transition
    ]);

    expect(h.summary.timesCut).toBe(3);
    expect(h.summary.versionsInPlayedZones).toBe(4);
  });

  it('excludes the working state from lastSeenSequence and versionsInPlayedZones', () => {
    const h = history([v(1, { mainboard: 1 }), v(2), working({ mainboard: 1 })]);

    expect(transitions(h)).toEqual(['first-seen', 'removed', 'restored']);
    expect(h.summary).toEqual({
      firstSeenSequence: 1,
      lastSeenSequence: 1,
      currentZones: [{ zone: 'mainboard', quantity: 1 }],
      versionCount: 2,

      versionsPresent: 1,

      versionsInPlayedZones: 1,
      timesCut: 1,
      timesRestored: 1,
    });
    expect(h.entries[2]).toMatchObject({
      commitId: null,
      sequence: null,
      restoredFrom: [{ zone: 'mainboard', lastSequence: 1 }],
    });
  });

  it('reports currentZones from the newest point, even when the card is gone', () => {
    expect(history([v(1, { mainboard: 1 }), working()]).summary.currentZones).toEqual([]);
    expect(history([v(1, { mainboard: 1 }), v(2, { sideboard: 2 })]).summary.currentZones).toEqual([
      { zone: 'sideboard', quantity: 2 },
    ]);
  });

  it('copies version metadata into entries and nothing else', () => {
    const point = { ...v(3, { mainboard: 1 }), extra: 'ignored' };
    const [entry] = history([point]).entries;

    expect(entry).toEqual({
      commitId: 'commit-3',
      sequence: 3,
      at: '2026-01-03T00:00:00.000Z',
      message: 'Version 3',
      zones: [{ zone: 'mainboard', quantity: 1 }],
      transition: 'first-seen',
      previousZones: [],
    });
  });

  it('does not mutate its input and is deterministic', () => {
    const points = deepFreeze([
      v(1, { mainboard: 1, considering: 0 }),
      v(2, { considering: 1 }),
      v(3, { mainboard: 1 }),
      working(),
    ]);

    const a = history(points);
    const b = history(points);

    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('never aliases zone arrays between entries, runs and summary', () => {
    const h = history([v(1, { mainboard: 1 }), v(2, { mainboard: 1 })]);

    expect(h.entries[1]?.previousZones).toEqual(h.entries[0]?.zones);
    expect(h.entries[1]?.previousZones).not.toBe(h.entries[0]?.zones);
    expect(h.runs[0]?.zones).not.toBe(h.entries[0]?.zones);
    expect(h.summary.currentZones).not.toBe(h.entries[1]?.zones);
  });

  it('shows a rename without counting it as a cut or an addition', () => {
    const renamedFrom = { key: 'æther vial', name: 'Æther Vial' };
    const h = deriveCardHistory({
      key: 'aether vial',
      name: 'Aether Vial',
      points: [
        v(1, { mainboard: 1 }),
        v(2, { mainboard: 1 }),
        { ...v(3, { mainboard: 1 }), renamedFrom },
        { ...v(4, { sideboard: 1 }), renamedFrom: { key: 'aether vial 2', name: 'Aether Vial 2' } },
        working({ sideboard: 1 }),
      ],
    });

    expect(transitions(h)).toEqual(['first-seen', 'unchanged', 'unchanged', 'moved', 'unchanged']);
    expect(h.entries[2]?.renamedFrom).toEqual(renamedFrom);
    expect(h.entries[2]?.renamedFrom).not.toBe(renamedFrom);
    expect(h.entries.map((e) => e.renamedFrom?.name)).toEqual([
      undefined,
      undefined,
      'Æther Vial',
      'Aether Vial 2',
      undefined,
    ]);
    expect(h.changes.map((e) => e.sequence)).toEqual([1, 3, 4]);
    // A rename starts a new run so the compressed timeline can show it.
    expect(h.runs.map((r) => [r.first.sequence, r.last.sequence])).toEqual([
      [1, 2],
      [3, 3],
      [4, null],
    ]);
    expect(h.summary).toMatchObject({ firstSeenSequence: 1, timesCut: 1, timesRestored: 0 });
  });

  describe('invariants (property-based)', () => {
    const zoneArb = fc.constantFrom<ZoneId>('commanders', 'mainboard', 'sideboard', 'considering', 'other:x');
    const zonesArb = fc.array(fc.record({ zone: zoneArb, quantity: fc.integer({ min: 0, max: 3 }) }), {
      maxLength: 4,
    });
    const pointArb = fc.record({ zones: zonesArb, renamed: fc.boolean() });
    const pointsArb = fc
      .tuple(fc.array(pointArb, { maxLength: 12 }), fc.option(pointArb, { nil: undefined }))
      .map(([committed, workingPoint]) =>
        [
          ...committed.map(({ zones, renamed }, i) => ({ ...v(i + 1), zones, renamed })),
          ...(workingPoint ? [{ ...working(), ...workingPoint }] : []),
        ].map(({ renamed, ...point }, i): CardVersionPoint =>
          renamed && i > 0 ? { ...point, renamedFrom: { key: `old ${i}`, name: `Old ${i}` } } : point,
        ),
      );

    it('keeps entries, changes, runs and summary consistent', () => {
      fc.assert(
        fc.property(pointsArb, (points) => {
          const h = history(points);

          expect(h.entries).toHaveLength(points.length);
          expect(h.changes).toEqual(
            h.entries.filter((e) => e.transition !== 'unchanged' || e.renamedFrom !== undefined),
          );
          expect(h.runs.reduce((n, r) => n + r.length, 0)).toBe(points.length);
          const isPlayed = (zones: readonly ZoneQuantity[]): boolean =>
            zones.some(({ zone }) => isPlayedZone(zone));
          const isCut = (e: CardHistoryEntry): boolean => isPlayed(e.previousZones) && !isPlayed(e.zones);
          expect(h.summary.timesCut).toBe(h.changes.filter(isCut).length);
          expect(h.summary.timesRestored).toBe(
            h.changes.filter((e) => e.transition === 'restored' && !isCut(e)).length,
          );

          h.entries.forEach((entry, i) => {
            const previous = h.entries[i - 1];
            expect(entry.previousZones).toEqual(previous?.zones ?? []);
            if (i > 0) {
              const same = JSON.stringify(entry.zones) === JSON.stringify(entry.previousZones);
              expect(entry.transition === 'unchanged').toBe(same);
            }
            expect(entry.restoredFrom !== undefined).toBe(entry.transition === 'restored');
            expect(entry.renamedFrom).toEqual(points[i]?.renamedFrom);
            for (const restored of entry.restoredFrom ?? []) {
              expect(entry.zones.map((z) => z.zone)).toContain(restored.zone);
              expect(entry.previousZones.map((z) => z.zone)).not.toContain(restored.zone);
            }
          });

          h.runs.forEach((run, i) => {
            const next = h.runs[i + 1];
            if (next && next.first.renamedFrom === undefined) expect(next.zones).not.toEqual(run.zones);
            expect(run.first.zones).toEqual(run.zones);
            expect(run.last.zones).toEqual(run.zones);
          });
        }),
      );
    });
  });
});

/** A version of the deck as `cardPointsFromSnapshots` takes it: committed as `sequence`, or the working state when `null`. */
function versioned(sequence: number | null, spec: Parameters<typeof buildSnapshot>[0]): VersionedSnapshot {
  return {
    commitId: sequence === null ? null : `commit-${sequence}`,
    sequence,
    at: '2026-01-01T00:00:00.000Z',
    message: sequence === null ? 'Current Moxfield deck' : `Version ${sequence}`,
    snapshot: buildSnapshot(spec),
  };
}

describe('cardPointsFromSnapshots', () => {
  it('extracts the zones holding the card, in canonical zone order', () => {
    const versions = [
      versioned(1, { zones: { mainboard: ['Dress Down', 'Island'] } }),
      versioned(2, {
        zones: { considering: ['Dress Down'], sideboard: ['2 Dress Down'], mainboard: ['Island'] },
      }),
      versioned(3, { zones: { mainboard: ['Island'] } }),
      versioned(null, { zones: { mainboard: ['3 Dress Down'] } }),
    ];

    expect(cardPointsFromSnapshots(KEY, versions)).toEqual([
      {
        commitId: 'commit-1',
        sequence: 1,
        at: '2026-01-01T00:00:00.000Z',
        message: 'Version 1',
        zones: [{ zone: 'mainboard', quantity: 1 }],
      },
      {
        commitId: 'commit-2',
        sequence: 2,
        at: '2026-01-01T00:00:00.000Z',
        message: 'Version 2',
        zones: [
          { zone: 'sideboard', quantity: 2 },
          { zone: 'considering', quantity: 1 },
        ],
      },
      {
        commitId: 'commit-3',
        sequence: 3,
        at: '2026-01-01T00:00:00.000Z',
        message: 'Version 3',
        zones: [],
      },
      {
        commitId: null,
        sequence: null,
        at: '2026-01-01T00:00:00.000Z',
        message: 'Current Moxfield deck',
        zones: [{ zone: 'mainboard', quantity: 3 }],
      },
    ]);
  });

  it('returns no points for no versions', () => {
    expect(cardPointsFromSnapshots(KEY, [])).toEqual([]);
  });

  it('feeds deriveCardHistory end to end', () => {
    const versions = [
      versioned(1, { zones: { mainboard: ['Dress Down', 'Island'] } }),
      versioned(2, { zones: { mainboard: ['Island'], considering: ['Dress Down'] } }),
      versioned(3, { zones: { mainboard: ['Island', 'Dress Down'] } }),
      versioned(null, { zones: { mainboard: ['Island'], considering: ['Dress Down'] } }),
    ];

    const h = deriveCardHistory({ key: KEY, name: NAME, points: cardPointsFromSnapshots(KEY, versions) });

    expect(transitions(h)).toEqual(['first-seen', 'moved', 'restored', 'restored']);
    expect(h.summary).toEqual({
      firstSeenSequence: 1,
      lastSeenSequence: 3,
      currentZones: [{ zone: 'considering', quantity: 1 }],
      versionCount: 3,

      versionsPresent: 3,

      versionsInPlayedZones: 2,
      timesCut: 2,
      timesRestored: 1,
    });
  });
});

describe('traceCardKeys', () => {
  /** Point contents as sets of keys, and renames into each point (old → new). */
  function trace(
    key: string,
    points: string[][],
    renamesInto: Record<number, Record<string, string>> = {},
  ): { keys: string[]; renameCalls: number[] } {
    const renameCalls: number[] = [];
    const keys = traceCardKeys({
      key,
      length: points.length,
      contains: (k, index) => points[index]?.includes(k) ?? false,
      renames: (index) => {
        renameCalls.push(index);
        return new Map(Object.entries(renamesInto[index] ?? {}));
      },
    });
    return { keys, renameCalls };
  }

  it('keeps the requested key when the card is never renamed', () => {
    expect(trace('a', [['a'], [], ['a', 'b']]).keys).toEqual(['a', 'a', 'a']);
    expect(trace('a', [[], []]).keys).toEqual(['a', 'a']);
    expect(trace('a', []).keys).toEqual([]);
  });

  it('follows a rename forward from the old key and backward from the new key', () => {
    const points = [['old'], ['old'], ['new'], ['new']];
    const renames = { 2: { old: 'new' } };
    expect(trace('old', points, renames).keys).toEqual(['old', 'old', 'new', 'new']);
    expect(trace('new', points, renames).keys).toEqual(['old', 'old', 'new', 'new']);
  });

  it('follows chains of renames from any of the names', () => {
    const points = [['a'], ['b'], ['b'], ['c']];
    const renames = { 1: { a: 'b' }, 3: { b: 'c' } };
    for (const key of ['a', 'b', 'c']) expect(trace(key, points, renames).keys).toEqual(['a', 'b', 'b', 'c']);
  });

  it('does not join a removal and a later addition, which the diff does not reconcile', () => {
    const points = [['old'], [], ['new']];
    expect(trace('new', points, { 1: { old: 'new' }, 2: { old: 'new' } }).keys).toEqual([
      'new',
      'new',
      'new',
    ]);
    expect(trace('old', points, { 1: { old: 'new' }, 2: { old: 'new' } }).keys).toEqual([
      'old',
      'old',
      'old',
    ]);
  });

  it('asks for renames only where the tracked key appears or disappears', () => {
    const points = [['a'], ['a'], ['a'], ['b'], ['b']];
    expect(trace('a', points, { 3: { a: 'b' } }).renameCalls).toEqual([3]);
    expect(trace('b', points, { 3: { a: 'b' } }).renameCalls).toEqual([3]);
  });
});

describe('cardPointsFromSnapshots across renames', () => {
  const vial = (name: string) => ({ name, ids: { moxfield: 'vial-id' } });
  const version = (sequence: number | null, zones: SnapshotSpec['zones']): VersionedSnapshot =>
    versioned(sequence, { zones });

  const versions = [
    version(1, { mainboard: ['Island', vial('Æther Vial')] }),
    version(2, { mainboard: ['Island', vial('Æther Vial'), 'Grim Tutor'] }),
    version(3, { mainboard: ['Island', vial('Aether Vial'), 'Grim Tutor'] }),
    version(null, { mainboard: ['Island', 'Grim Tutor'], considering: [vial('Aether Vial')] }),
  ];

  it('follows a card across a rename the diff reconciles, from either name', () => {
    const expected = [
      [[{ zone: 'mainboard', quantity: 1 }], undefined],
      [[{ zone: 'mainboard', quantity: 1 }], undefined],
      [[{ zone: 'mainboard', quantity: 1 }], { key: 'æther vial', name: 'Æther Vial' }],
      [[{ zone: 'considering', quantity: 1 }], undefined],
    ];
    for (const key of ['aether vial', 'æther vial']) {
      const points = cardPointsFromSnapshots(key, versions);
      expect(points.map((point) => [point.zones, point.renamedFrom])).toEqual(expected);
      const h = deriveCardHistory({ key: 'aether vial', name: 'Aether Vial', points });
      expect(transitions(h)).toEqual(['first-seen', 'unchanged', 'unchanged', 'moved']);
      expect(h.summary).toMatchObject({ firstSeenSequence: 1, versionsInPlayedZones: 3, timesCut: 1 });
    }
  });

  it('keeps an ambiguous rename a removal and an addition, like the diff', () => {
    const ambiguous = [
      version(1, { mainboard: [vial('Æther Vial')] }),
      version(2, { mainboard: [vial('Aether Vial'), vial('Aether Vial Token')] }),
    ];
    expect(cardPointsFromSnapshots('æther vial', ambiguous).map((point) => point.zones)).toEqual([
      [{ zone: 'mainboard', quantity: 1 }],
      [],
    ]);
    expect(cardPointsFromSnapshots('aether vial', ambiguous).map((point) => point.zones)).toEqual([
      [],
      [{ zone: 'mainboard', quantity: 1 }],
    ]);
  });
});
