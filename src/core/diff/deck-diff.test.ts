import { describe, expect, it } from 'vitest';

import {
  addCard as add,
  baseDeckSpec,
  baseWith,
  buildSnapshot,
  moveCardSpec as move,
  removeCard as remove,
  type CardSpec,
  type SnapshotSpec,
} from '@tests/support/builders';

import { emptySnapshot, findCard, stableStringify } from '../canonical';
import type { CanonicalPrinting, CanonicalSnapshot } from '../model';
import type { ZoneId } from '../zones';
import { changeTouchesZone, changeZones, compareCardChanges, diffSnapshots } from './deck-diff';
import type { CardChange, DeckDiff, DiffStats, ZoneDiffStats } from './types';

const BASE_COMMANDERS = ["Kraum, Ludevic's Opus", 'Tymna the Weaver'];

function base(): CanonicalSnapshot {
  return buildSnapshot(baseDeckSpec());
}

function zoneStats(zone: ZoneId, counts: Partial<Omit<ZoneDiffStats, 'zone'>>): ZoneDiffStats {
  return { zone, added: 0, removed: 0, movedIn: 0, movedOut: 0, ...counts };
}

function stats(overrides: Partial<DiffStats> = {}): DiffStats {
  return { zones: [], moves: [], printingChanges: 0, tagChanges: 0, renames: 0, ...overrides };
}

/** A complete expected diff between two variants of the base deck. */
function expectedDiff(overrides: Partial<DeckDiff>): DeckDiff {
  return {
    changes: [],
    deck: [],
    primer: { status: 'unchanged' },
    commanders: { before: BASE_COMMANDERS, after: BASE_COMMANDERS, changed: false },
    stats: stats(),
    isEmpty: false,
    hasCardChanges: true,
    onlyCosmetic: false,
    ...overrides,
  };
}

function printingsOf(snapshot: CanonicalSnapshot, zone: ZoneId, key: string): CanonicalPrinting[] {
  const card = findCard(snapshot, zone, key);
  if (!card) throw new Error(`${key} is not in ${zone}`);
  return card.printings;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe('diffSnapshots — additions, removals and quantities', () => {
  it('reports a simple addition', () => {
    const after = baseWith((zones) => {
      add(zones, 'mainboard', 'Final Fortune');
    });
    expect(diffSnapshots(base(), after)).toEqual(
      expectedDiff({
        changes: [
          { type: 'added', key: 'final fortune', name: 'Final Fortune', zone: 'mainboard', quantity: 1 },
        ],
        stats: stats({ zones: [zoneStats('mainboard', { added: 1 })] }),
      }),
    );
  });

  it('reports a simple removal', () => {
    const after = baseWith((zones) => {
      remove(zones, 'mainboard', 'Rhystic Study');
    });
    expect(diffSnapshots(base(), after)).toEqual(
      expectedDiff({
        changes: [
          { type: 'removed', key: 'rhystic study', name: 'Rhystic Study', zone: 'mainboard', quantity: 1 },
        ],
        stats: stats({ zones: [zoneStats('mainboard', { removed: 1 })] }),
      }),
    );
  });

  it('reports a quantity increase', () => {
    const after = baseWith((zones) => {
      remove(zones, 'mainboard', 'Island');
      add(zones, 'mainboard', '5 Island');
    });
    expect(diffSnapshots(base(), after)).toEqual(
      expectedDiff({
        changes: [{ type: 'quantity', key: 'island', name: 'Island', zone: 'mainboard', from: 3, to: 5 }],
        stats: stats({ zones: [zoneStats('mainboard', { added: 2 })] }),
      }),
    );
  });

  it('reports a quantity decrease', () => {
    const after = baseWith((zones) => {
      remove(zones, 'mainboard', 'Island');
      add(zones, 'mainboard', '1 Island');
    });
    expect(diffSnapshots(base(), after)).toEqual(
      expectedDiff({
        changes: [{ type: 'quantity', key: 'island', name: 'Island', zone: 'mainboard', from: 3, to: 1 }],
        stats: stats({ zones: [zoneStats('mainboard', { removed: 2 })] }),
      }),
    );
  });

  it('reports every card of the first version as added (empty → full deck)', () => {
    const diff = diffSnapshots(emptySnapshot(), base());
    const added = (key: string, name: string, zone: ZoneId, quantity = 1): CardChange => ({
      type: 'added',
      key,
      name,
      zone,
      quantity,
    });
    expect(diff).toEqual({
      changes: [
        added("kraum, ludevic's opus", "Kraum, Ludevic's Opus", 'commanders'),
        added('tymna the weaver', 'Tymna the Weaver', 'commanders'),
        added('demonic tutor', 'Demonic Tutor', 'mainboard'),
        added('dress down', 'Dress Down', 'mainboard'),
        added('island', 'Island', 'mainboard', 3),
        added('rhystic study', 'Rhystic Study', 'mainboard'),
        added('sol ring', 'Sol Ring', 'mainboard'),
        added("thassa's oracle", "Thassa's Oracle", 'mainboard'),
        added('underworld breach', 'Underworld Breach', 'mainboard'),
        added('orcish bowmasters', 'Orcish Bowmasters', 'sideboard'),
        added('mnemonic betrayal', 'Mnemonic Betrayal', 'considering'),
        added('peer into the abyss', 'Peer into the Abyss', 'considering'),
      ],
      deck: [
        { field: 'name', before: '', after: 'Blue Farm' },
        { field: 'format', before: '', after: 'commander' },
        { field: 'tags', before: [], after: ['cEDH'], added: ['cEDH'], removed: [] },
      ],
      primer: { status: 'changed', addedLines: 3, removedLines: 0 },
      commanders: { before: [], after: BASE_COMMANDERS, changed: true },
      stats: stats({
        zones: [
          zoneStats('commanders', { added: 2 }),
          zoneStats('mainboard', { added: 9 }),
          zoneStats('sideboard', { added: 1 }),
          zoneStats('considering', { added: 2 }),
        ],
      }),
      isEmpty: false,
      hasCardChanges: true,
      onlyCosmetic: false,
    } satisfies DeckDiff);
  });

  it('reports an empty diff for identical snapshots', () => {
    expect(diffSnapshots(base(), base())).toEqual(
      expectedDiff({ isEmpty: true, hasCardChanges: false, onlyCosmetic: false }),
    );
  });
});

describe('diffSnapshots — moves', () => {
  it('reports mainboard → considering as a single move', () => {
    const after = baseWith((zones) => {
      move(zones, 'Dress Down', 'mainboard', 'considering');
    });
    expect(diffSnapshots(base(), after)).toEqual(
      expectedDiff({
        changes: [
          {
            type: 'moved',
            key: 'dress down',
            name: 'Dress Down',
            from: 'mainboard',
            to: 'considering',
            quantity: 1,
          },
        ],
        stats: stats({
          zones: [zoneStats('mainboard', { movedOut: 1 }), zoneStats('considering', { movedIn: 1 })],
          moves: [{ from: 'mainboard', to: 'considering', quantity: 1, cards: 1 }],
        }),
      }),
    );
  });

  it('reports considering → mainboard as a single move', () => {
    const after = baseWith((zones) => {
      move(zones, 'Mnemonic Betrayal', 'considering', 'mainboard');
    });
    expect(diffSnapshots(base(), after)).toEqual(
      expectedDiff({
        changes: [
          {
            type: 'moved',
            key: 'mnemonic betrayal',
            name: 'Mnemonic Betrayal',
            from: 'considering',
            to: 'mainboard',
            quantity: 1,
          },
        ],
        stats: stats({
          zones: [zoneStats('mainboard', { movedIn: 1 }), zoneStats('considering', { movedOut: 1 })],
          moves: [{ from: 'considering', to: 'mainboard', quantity: 1, cards: 1 }],
        }),
      }),
    );
  });

  it('reports sideboard → mainboard as a single move (sideboard becomes empty)', () => {
    const after = baseWith((zones) => {
      move(zones, 'Orcish Bowmasters', 'sideboard', 'mainboard');
    });
    expect(after.zones.sideboard).toBeUndefined();
    expect(diffSnapshots(base(), after)).toEqual(
      expectedDiff({
        changes: [
          {
            type: 'moved',
            key: 'orcish bowmasters',
            name: 'Orcish Bowmasters',
            from: 'sideboard',
            to: 'mainboard',
            quantity: 1,
          },
        ],
        stats: stats({
          zones: [zoneStats('mainboard', { movedIn: 1 }), zoneStats('sideboard', { movedOut: 1 })],
          moves: [{ from: 'sideboard', to: 'mainboard', quantity: 1, cards: 1 }],
        }),
      }),
    );
  });

  it('moves part of a card that sits in several zones', () => {
    const before = buildSnapshot({ zones: { mainboard: ['3 Island'], considering: ['1 Island'] } });
    const after = buildSnapshot({ zones: { mainboard: ['2 Island'], considering: ['2 Island'] } });
    expect(diffSnapshots(before, after)).toEqual(
      expectedDiff({
        changes: [
          { type: 'moved', key: 'island', name: 'Island', from: 'mainboard', to: 'considering', quantity: 1 },
        ],
        commanders: { before: [], after: [], changed: false },
        stats: stats({
          zones: [zoneStats('mainboard', { movedOut: 1 }), zoneStats('considering', { movedIn: 1 })],
          moves: [{ from: 'mainboard', to: 'considering', quantity: 1, cards: 1 }],
        }),
      }),
    );
  });

  it('combines a move with a quantity increase in the destination (1 main → 3 considering)', () => {
    const before = buildSnapshot({ zones: { mainboard: ['Brainstorm', 'Ponder'] } });
    const after = buildSnapshot({ zones: { mainboard: ['Ponder'], considering: ['3 Brainstorm'] } });
    expect(diffSnapshots(before, after)).toEqual(
      expectedDiff({
        changes: [
          {
            type: 'moved',
            key: 'brainstorm',
            name: 'Brainstorm',
            from: 'mainboard',
            to: 'considering',
            quantity: 1,
          },
          { type: 'quantity', key: 'brainstorm', name: 'Brainstorm', zone: 'considering', from: 1, to: 3 },
        ],
        commanders: { before: [], after: [], changed: false },
        stats: stats({
          zones: [
            zoneStats('mainboard', { movedOut: 1 }),
            zoneStats('considering', { added: 2, movedIn: 1 }),
          ],
          moves: [{ from: 'mainboard', to: 'considering', quantity: 1, cards: 1 }],
        }),
      }),
    );
  });

  it('combines a move with a removal from the source (3 main → 1 considering)', () => {
    const before = buildSnapshot({ zones: { mainboard: ['3 Brainstorm', 'Ponder'] } });
    const after = buildSnapshot({ zones: { mainboard: ['Ponder'], considering: ['1 Brainstorm'] } });
    expect(diffSnapshots(before, after)).toEqual(
      expectedDiff({
        changes: [
          {
            type: 'moved',
            key: 'brainstorm',
            name: 'Brainstorm',
            from: 'mainboard',
            to: 'considering',
            quantity: 1,
          },
          { type: 'removed', key: 'brainstorm', name: 'Brainstorm', zone: 'mainboard', quantity: 2 },
        ],
        commanders: { before: [], after: [], changed: false },
        stats: stats({
          zones: [
            zoneStats('mainboard', { removed: 2, movedOut: 1 }),
            zoneStats('considering', { movedIn: 1 }),
          ],
          moves: [{ from: 'mainboard', to: 'considering', quantity: 1, cards: 1 }],
        }),
      }),
    );
  });

  it('pairs multiple sources and sinks greedily in canonical zone order', () => {
    const before = buildSnapshot({
      zones: { mainboard: ['3 Island', 'Brainstorm'], sideboard: ['2 Island', 'Ponder'] },
    });
    const after = buildSnapshot({
      zones: {
        considering: ['2 Island', 'Brainstorm', 'Ponder'],
        'other:wishboard': ['3 Island'],
      },
    });
    expect(diffSnapshots(before, after)).toEqual(
      expectedDiff({
        changes: [
          {
            type: 'moved',
            key: 'brainstorm',
            name: 'Brainstorm',
            from: 'mainboard',
            to: 'considering',
            quantity: 1,
          },
          { type: 'moved', key: 'island', name: 'Island', from: 'mainboard', to: 'considering', quantity: 2 },
          {
            type: 'moved',
            key: 'island',
            name: 'Island',
            from: 'mainboard',
            to: 'other:wishboard',
            quantity: 1,
          },
          { type: 'moved', key: 'ponder', name: 'Ponder', from: 'sideboard', to: 'considering', quantity: 1 },
          {
            type: 'moved',
            key: 'island',
            name: 'Island',
            from: 'sideboard',
            to: 'other:wishboard',
            quantity: 2,
          },
        ],
        commanders: { before: [], after: [], changed: false },
        stats: stats({
          zones: [
            zoneStats('mainboard', { movedOut: 4 }),
            zoneStats('sideboard', { movedOut: 3 }),
            zoneStats('considering', { movedIn: 4 }),
            zoneStats('other:wishboard', { movedIn: 3 }),
          ],
          moves: [
            { from: 'mainboard', to: 'considering', quantity: 3, cards: 2 },
            { from: 'mainboard', to: 'other:wishboard', quantity: 1, cards: 1 },
            { from: 'sideboard', to: 'considering', quantity: 1, cards: 1 },
            { from: 'sideboard', to: 'other:wishboard', quantity: 2, cards: 1 },
          ],
        }),
      }),
    );
  });

  it('reports only the net change across several intermediate versions', () => {
    const v1 = base();
    const v2 = baseWith((zones) => {
      move(zones, 'Dress Down', 'mainboard', 'considering');
      add(zones, 'mainboard', 'Final Fortune');
    });
    const v3 = baseWith((zones) => {
      add(zones, 'mainboard', 'Final Fortune');
      remove(zones, 'mainboard', 'Island');
      add(zones, 'mainboard', '4 Island');
      remove(zones, 'considering', 'Peer into the Abyss');
    });
    const v4 = baseWith((zones) => {
      add(zones, 'considering', 'Final Fortune');
      remove(zones, 'considering', 'Peer into the Abyss');
    });

    expect(diffSnapshots(v1, v2).changes.map((c) => c.type)).toEqual(['moved', 'added']);
    expect(diffSnapshots(v2, v3).changes.map((c) => c.type)).toEqual(['moved', 'removed', 'quantity']);
    expect(diffSnapshots(v3, v4).changes.map((c) => c.type)).toEqual(['moved', 'quantity']);
    expect(diffSnapshots(v1, v4)).toEqual(
      expectedDiff({
        changes: [
          {
            type: 'added',
            key: 'final fortune',
            name: 'Final Fortune',
            zone: 'considering',
            quantity: 1,
          },
          {
            type: 'removed',
            key: 'peer into the abyss',
            name: 'Peer into the Abyss',
            zone: 'considering',
            quantity: 1,
          },
        ],
        stats: stats({ zones: [zoneStats('considering', { added: 1, removed: 1 })] }),
      }),
    );
  });

  it('reports no change when a card moved out and back in between versions', () => {
    const v1 = base();
    const v2 = baseWith((zones) => {
      move(zones, 'Dress Down', 'mainboard', 'considering');
    });
    const v3 = base();
    expect(diffSnapshots(v1, v2).hasCardChanges).toBe(true);
    expect(diffSnapshots(v1, v3).isEmpty).toBe(true);
  });
});

describe('diffSnapshots — commanders', () => {
  it('reports a partner swap (Kraum → Tana) in the commanders zone', () => {
    const after = baseWith((zones) => {
      remove(zones, 'commanders', "Kraum, Ludevic's Opus");
      add(zones, 'commanders', 'Tana, the Bloodsower');
    });
    expect(diffSnapshots(base(), after)).toEqual(
      expectedDiff({
        changes: [
          {
            type: 'added',
            key: 'tana, the bloodsower',
            name: 'Tana, the Bloodsower',
            zone: 'commanders',
            quantity: 1,
          },
          {
            type: 'removed',
            key: "kraum, ludevic's opus",
            name: "Kraum, Ludevic's Opus",
            zone: 'commanders',
            quantity: 1,
          },
        ],
        commanders: {
          before: BASE_COMMANDERS,
          after: ['Tana, the Bloodsower', 'Tymna the Weaver'],
          changed: true,
        },
        stats: stats({ zones: [zoneStats('commanders', { added: 1, removed: 1 })] }),
      }),
    );
  });

  it('reports a commander moved to the mainboard as a move', () => {
    const after = baseWith((zones) => {
      move(zones, "Kraum, Ludevic's Opus", 'commanders', 'mainboard');
      add(zones, 'commanders', 'Tana, the Bloodsower');
    });
    expect(diffSnapshots(base(), after)).toEqual(
      expectedDiff({
        changes: [
          {
            type: 'moved',
            key: "kraum, ludevic's opus",
            name: "Kraum, Ludevic's Opus",
            from: 'commanders',
            to: 'mainboard',
            quantity: 1,
          },
          {
            type: 'added',
            key: 'tana, the bloodsower',
            name: 'Tana, the Bloodsower',
            zone: 'commanders',
            quantity: 1,
          },
        ],
        commanders: {
          before: BASE_COMMANDERS,
          after: ['Tana, the Bloodsower', 'Tymna the Weaver'],
          changed: true,
        },
        stats: stats({
          zones: [zoneStats('commanders', { added: 1, movedOut: 1 }), zoneStats('mainboard', { movedIn: 1 })],
          moves: [{ from: 'commanders', to: 'mainboard', quantity: 1, cards: 1 }],
        }),
      }),
    );
  });

  it('does not mark commanders as changed for a cosmetic commander printing change', () => {
    const after = baseWith((zones) => {
      remove(zones, 'commanders', 'Tymna the Weaver');
      add(zones, 'commanders', {
        name: 'Tymna the Weaver',
        printings: [{ set: 'c16', collectorNumber: '48', finish: 'foil' }],
      });
    });
    const diff = diffSnapshots(base(), after);
    expect(diff.commanders).toEqual({ before: BASE_COMMANDERS, after: BASE_COMMANDERS, changed: false });
    expect(diff.changes.map((c) => c.type)).toEqual(['printing']);
  });
});

describe('diffSnapshots — printings', () => {
  it('reports a printing-only change as cosmetic', () => {
    const before = base();
    const after = baseWith((zones) => {
      remove(zones, 'mainboard', 'Sol Ring');
      add(zones, 'mainboard', { name: 'Sol Ring', printings: [{ set: 'cmm', collectorNumber: '703' }] });
    });
    expect(diffSnapshots(before, after)).toEqual(
      expectedDiff({
        changes: [
          {
            type: 'printing',
            key: 'sol ring',
            name: 'Sol Ring',
            zone: 'mainboard',
            before: printingsOf(before, 'mainboard', 'sol ring'),
            after: [
              { set: 'cmm', collectorNumber: '703', finish: 'nonfoil', lang: 'en', quantity: 1, ids: {} },
            ],
          },
        ],
        stats: stats({ printingChanges: 1 }),
        hasCardChanges: false,
        onlyCosmetic: true,
      }),
    );
  });

  it('reports a changed printing distribution with equal totals', () => {
    const before = buildSnapshot({
      zones: {
        mainboard: [
          {
            name: 'Island',
            printings: [
              { set: 'unf', collectorNumber: '235', quantity: 2 },
              { set: 'sld', collectorNumber: '63', quantity: 1 },
            ],
          },
        ],
      },
    });
    const after = buildSnapshot({
      zones: {
        mainboard: [
          {
            name: 'Island',
            printings: [
              { set: 'unf', collectorNumber: '235', quantity: 1 },
              { set: 'sld', collectorNumber: '63', quantity: 2 },
            ],
          },
        ],
      },
    });
    expect(diffSnapshots(before, after)).toEqual(
      expectedDiff({
        changes: [
          {
            type: 'printing',
            key: 'island',
            name: 'Island',
            zone: 'mainboard',
            before: printingsOf(before, 'mainboard', 'island'),
            after: printingsOf(after, 'mainboard', 'island'),
          },
        ],
        commanders: { before: [], after: [], changed: false },
        stats: stats({ printingChanges: 1 }),
        hasCardChanges: false,
        onlyCosmetic: true,
      }),
    );
  });

  it('does not report a printing change for a quantity change within the same printings', () => {
    const before = buildSnapshot({
      zones: {
        mainboard: [{ name: 'Island', printings: [{ set: 'unf', collectorNumber: '235', quantity: 2 }] }],
      },
    });
    const after = buildSnapshot({
      zones: {
        mainboard: [{ name: 'Island', printings: [{ set: 'unf', collectorNumber: '235', quantity: 5 }] }],
      },
    });
    expect(diffSnapshots(before, after)).toEqual(
      expectedDiff({
        changes: [{ type: 'quantity', key: 'island', name: 'Island', zone: 'mainboard', from: 2, to: 5 }],
        commanders: { before: [], after: [], changed: false },
        stats: stats({ zones: [zoneStats('mainboard', { added: 3 })] }),
      }),
    );
  });

  it('reports a printing change alongside a quantity change when a new printing appears', () => {
    const before = buildSnapshot({
      zones: {
        mainboard: [{ name: 'Island', printings: [{ set: 'unf', collectorNumber: '235', quantity: 2 }] }],
      },
    });
    const after = buildSnapshot({
      zones: {
        mainboard: [
          {
            name: 'Island',
            printings: [
              { set: 'unf', collectorNumber: '235', quantity: 2 },
              { set: 'sld', collectorNumber: '63', quantity: 1 },
            ],
          },
        ],
      },
    });
    const diff = diffSnapshots(before, after);
    expect(diff.changes).toEqual([
      { type: 'quantity', key: 'island', name: 'Island', zone: 'mainboard', from: 2, to: 3 },
      {
        type: 'printing',
        key: 'island',
        name: 'Island',
        zone: 'mainboard',
        before: printingsOf(before, 'mainboard', 'island'),
        after: printingsOf(after, 'mainboard', 'island'),
      },
    ]);
    expect(diff.stats).toEqual(stats({ zones: [zoneStats('mainboard', { added: 1 })], printingChanges: 1 }));
    expect(diff.onlyCosmetic).toBe(false);
  });

  it('never turns printing or source-id differences into additions or removals', () => {
    const solRing = (set: string, collectorNumber: string, scryfall: string, moxfield: string): CardSpec => ({
      name: 'Sol Ring',
      ids: { moxfield: 'mox-sol-ring', scryfallOracle: 'oracle-sol-ring' },
      printings: [{ set, collectorNumber, finish: 'foil', ids: { scryfall, moxfield } }],
    });
    const before = buildSnapshot({ zones: { mainboard: [solRing('c21', '263', 'scry-1', 'mox-p1')] } });
    const after = buildSnapshot({ zones: { mainboard: [solRing('ltc', '284', 'scry-2', 'mox-p2')] } });
    const diff = diffSnapshots(before, after);
    expect(diff.changes).toEqual([
      {
        type: 'printing',
        key: 'sol ring',
        name: 'Sol Ring',
        zone: 'mainboard',
        before: printingsOf(before, 'mainboard', 'sol ring'),
        after: printingsOf(after, 'mainboard', 'sol ring'),
      },
    ]);
    expect(diff.hasCardChanges).toBe(false);
    expect(diff.onlyCosmetic).toBe(true);
  });

  it('ignores re-identified printings (same printing, different source ids)', () => {
    const island = (scryfall: string): SnapshotSpec => ({
      zones: {
        mainboard: [
          { name: 'Island', printings: [{ set: 'unf', collectorNumber: '235', ids: { scryfall } }] },
        ],
      },
    });
    const diff = diffSnapshots(buildSnapshot(island('old-id')), buildSnapshot(island('new-id')));
    expect(diff.isEmpty).toBe(true);
    expect(diff.changes).toEqual([]);
  });

  it('distinguishes printings by finish, language and flags', () => {
    const island = (printing: { finish?: string; lang?: string; flags?: string[] }): CanonicalSnapshot =>
      buildSnapshot({
        zones: {
          mainboard: [{ name: 'Island', printings: [{ set: 'unf', collectorNumber: '235', ...printing }] }],
        },
      });
    const plain = island({});
    expect(diffSnapshots(plain, island({ finish: 'foil' })).stats.printingChanges).toBe(1);
    expect(diffSnapshots(plain, island({ lang: 'ja' })).stats.printingChanges).toBe(1);
    expect(diffSnapshots(plain, island({ flags: ['alter'] })).stats.printingChanges).toBe(1);
  });

  it('claims no printing change when one side has no printing information', () => {
    const withPrinting = buildSnapshot({ zones: { mainboard: ['Island'] } });
    const withoutPrinting = buildSnapshot({ zones: { mainboard: [{ name: 'Island', noPrintings: true }] } });
    expect(diffSnapshots(withPrinting, withoutPrinting).isEmpty).toBe(true);
    expect(diffSnapshots(withoutPrinting, withPrinting).isEmpty).toBe(true);
  });

  it('does not report printing changes for zones involved in a move', () => {
    const before = buildSnapshot({
      zones: {
        mainboard: [{ name: 'Island', printings: [{ set: 'unf', collectorNumber: '235', quantity: 3 }] }],
      },
    });
    const after = buildSnapshot({
      zones: {
        mainboard: [{ name: 'Island', printings: [{ set: 'sld', collectorNumber: '63', quantity: 2 }] }],
        considering: [{ name: 'Island', printings: [{ set: 'unf', collectorNumber: '235', quantity: 1 }] }],
      },
    });
    expect(diffSnapshots(before, after).changes).toEqual([
      { type: 'moved', key: 'island', name: 'Island', from: 'mainboard', to: 'considering', quantity: 1 },
    ]);
  });
});

describe('diffSnapshots — renames', () => {
  /** Same printing under both names, so only the name differs. */
  const godzilla = (name: string, ids: { moxfield?: string; scryfallOracle?: string }): CardSpec => ({
    name,
    ids,
    printings: [{ set: 'iko', collectorNumber: '275' }],
  });

  it('reconciles a rename via a shared Moxfield id into a single renamed change', () => {
    const before = buildSnapshot({
      zones: { mainboard: ['Island', godzilla('Zilortha, Strength Incarnate', { moxfield: 'uniq-1' })] },
    });
    const after = buildSnapshot({
      zones: { mainboard: ['Island', godzilla('Godzilla, King of the Monsters', { moxfield: 'uniq-1' })] },
    });
    expect(diffSnapshots(before, after)).toEqual(
      expectedDiff({
        changes: [
          {
            type: 'renamed',
            key: 'godzilla, king of the monsters',
            name: 'Godzilla, King of the Monsters',
            previousName: 'Zilortha, Strength Incarnate',
          },
        ],
        commanders: { before: [], after: [], changed: false },
        stats: stats({ renames: 1 }),
        hasCardChanges: false,
        onlyCosmetic: true,
      }),
    );
  });

  it('reconciles a rename via a shared Scryfall oracle id and diffs the card under its new key', () => {
    const before = buildSnapshot({
      zones: { mainboard: [godzilla('Old Name', { scryfallOracle: 'oracle-1' })] },
      cardTags: { 'Old Name': ['finisher'] },
    });
    const after = buildSnapshot({
      zones: { considering: [godzilla('New Name', { scryfallOracle: 'oracle-1' })] },
      cardTags: { 'New Name': ['finisher'] },
    });
    expect(diffSnapshots(before, after)).toEqual(
      expectedDiff({
        changes: [
          {
            type: 'moved',
            key: 'new name',
            name: 'New Name',
            from: 'mainboard',
            to: 'considering',
            quantity: 1,
          },
          { type: 'renamed', key: 'new name', name: 'New Name', previousName: 'Old Name' },
        ],
        commanders: { before: [], after: [], changed: false },
        stats: stats({
          zones: [zoneStats('mainboard', { movedOut: 1 }), zoneStats('considering', { movedIn: 1 })],
          moves: [{ from: 'mainboard', to: 'considering', quantity: 1, cards: 1 }],
          renames: 1,
        }),
      }),
    );
  });

  it('does not reconcile ambiguous candidates', () => {
    const before = buildSnapshot({ zones: { mainboard: [godzilla('Old Name', { moxfield: 'uniq-1' })] } });
    const after = buildSnapshot({
      zones: {
        mainboard: [
          godzilla('New Name', { moxfield: 'uniq-1' }),
          godzilla('Other Name', { moxfield: 'uniq-1' }),
        ],
      },
    });
    expect(diffSnapshots(before, after).changes.map((c) => [c.type, c.key])).toEqual([
      ['added', 'new name'],
      ['added', 'other name'],
      ['removed', 'old name'],
    ]);
  });

  it('does not reconcile when the new key also exists in the older snapshot', () => {
    const before = buildSnapshot({
      zones: {
        mainboard: [godzilla('Old Name', { moxfield: 'uniq-1' })],
        considering: [godzilla('New Name', { moxfield: 'uniq-1' })],
      },
    });
    const after = buildSnapshot({ zones: { mainboard: [godzilla('New Name', { moxfield: 'uniq-1' })] } });
    expect(diffSnapshots(before, after).changes.map((c) => [c.type, c.key])).toEqual([
      ['moved', 'new name'],
      ['removed', 'old name'],
    ]);
  });

  it('does not reconcile cards without shared ids', () => {
    const before = buildSnapshot({ zones: { mainboard: [godzilla('Old Name', { moxfield: 'uniq-1' })] } });
    const after = buildSnapshot({ zones: { mainboard: [godzilla('New Name', { moxfield: 'uniq-2' })] } });
    expect(diffSnapshots(before, after).changes.map((c) => c.type)).toEqual(['added', 'removed']);
  });
});

describe('diffSnapshots — card tags, deck info and primer', () => {
  it('reports per-card tag changes as cosmetic', () => {
    const before = buildSnapshot({
      ...baseDeckSpec(),
      cardTags: { 'Dress Down': ['hate', 'stax'], 'Sol Ring': ['ramp'] },
    });
    const after = buildSnapshot({
      ...baseDeckSpec(),
      cardTags: { 'Dress Down': ['hate', 'removal'], 'Rhystic Study': ['draw'] },
    });
    expect(diffSnapshots(before, after)).toEqual(
      expectedDiff({
        changes: [
          { type: 'tags', key: 'dress down', name: 'Dress Down', added: ['removal'], removed: ['stax'] },
          { type: 'tags', key: 'rhystic study', name: 'Rhystic Study', added: ['draw'], removed: [] },
          { type: 'tags', key: 'sol ring', name: 'Sol Ring', added: [], removed: ['ramp'] },
        ],
        stats: stats({ tagChanges: 3 }),
        hasCardChanges: false,
        onlyCosmetic: true,
      }),
    );
  });

  it('uses the older name for tags of a card that left the deck', () => {
    const before = buildSnapshot({ ...baseDeckSpec(), cardTags: { 'Dress Down': ['stax'] } });
    const after = baseWith((zones) => {
      remove(zones, 'mainboard', 'Dress Down');
    });
    expect(diffSnapshots(before, after).changes).toEqual([
      { type: 'removed', key: 'dress down', name: 'Dress Down', zone: 'mainboard', quantity: 1 },
      { type: 'tags', key: 'dress down', name: 'Dress Down', added: [], removed: ['stax'] },
    ]);
  });

  it('reports deck info changes in field order', () => {
    const after = baseWith((_zones, spec) => {
      spec.deck = { name: 'Blue Farm v2', format: 'duel', description: 'Turbo', tags: ['cEDH', 'Turbo'] };
    });
    expect(diffSnapshots(base(), after)).toEqual(
      expectedDiff({
        deck: [
          { field: 'name', before: 'Blue Farm', after: 'Blue Farm v2' },
          { field: 'format', before: 'commander', after: 'duel' },
          { field: 'description', before: '', after: 'Turbo' },
          // Ordinal (UTF-16) order: uppercase sorts before lowercase.
          { field: 'tags', before: ['cEDH'], after: ['Turbo', 'cEDH'], added: ['Turbo'], removed: [] },
        ],
        hasCardChanges: false,
        onlyCosmetic: false,
      }),
    );
  });

  it('reports a primer-only change with line counts', () => {
    const after = baseWith((_zones, spec) => {
      spec.primer = "# Blue Farm\n\nWin with Thassa's Oracle or Underworld Breach.\n\n## Mulligans\n";
    });
    expect(diffSnapshots(base(), after)).toEqual(
      expectedDiff({
        primer: { status: 'changed', addedLines: 3, removedLines: 1 },
        hasCardChanges: false,
        onlyCosmetic: false,
      }),
    );
  });

  it('treats a primer that went missing (null) as unknown, not as a change', () => {
    const after = baseWith((_zones, spec) => {
      spec.primer = null;
    });
    expect(diffSnapshots(base(), after)).toEqual(
      expectedDiff({ primer: { status: 'unknown' }, isEmpty: true, hasCardChanges: false }),
    );
    expect(diffSnapshots(after, after).primer).toEqual({ status: 'unknown' });
    expect(diffSnapshots(after, after).isEmpty).toBe(true);
  });

  it('treats a primer captured after a missing (null) one as a change', () => {
    const before = baseWith((_zones, spec) => {
      spec.primer = null;
    });
    expect(diffSnapshots(before, base())).toEqual(
      expectedDiff({ primer: { status: 'captured' }, hasCardChanges: false, onlyCosmetic: false }),
    );
    const empty = baseWith((_zones, spec) => {
      spec.primer = '';
    });
    expect(diffSnapshots(before, empty)).toEqual(
      expectedDiff({ primer: { status: 'unknown' }, isEmpty: true, hasCardChanges: false }),
    );
  });

  it('is not cosmetic-only when deck info changes alongside cosmetic changes', () => {
    const after = buildSnapshot({
      ...baseDeckSpec(),
      deck: { name: 'Renamed', format: 'commander', tags: ['cEDH'] },
      cardTags: { 'Sol Ring': ['ramp'] },
    });
    const diff = diffSnapshots(base(), after);
    expect(diff.changes.map((c) => c.type)).toEqual(['tags']);
    expect(diff).toMatchObject({ isEmpty: false, hasCardChanges: false, onlyCosmetic: false });
  });
});

describe('diffSnapshots — ordering and purity', () => {
  it('orders changes by type, then zone, then key', () => {
    const before = buildSnapshot({
      zones: {
        commanders: ['Tymna the Weaver'],
        mainboard: [
          'Brainstorm',
          '2 Island',
          'Ponder',
          { name: 'Old Name', ids: { moxfield: 'u1' }, printings: [{}] },
        ],
        considering: ['Gitaxian Probe'],
      },
      cardTags: { Ponder: ['cantrip'] },
    });
    const after = buildSnapshot({
      zones: {
        commanders: ['Tymna the Weaver'],
        mainboard: [
          '3 Island',
          { name: 'Ponder', printings: [{ set: 'm12', collectorNumber: '73' }] },
          { name: 'New Name', ids: { moxfield: 'u1' }, printings: [{}] },
          'Preordain',
        ],
        considering: ['Brainstorm'],
        sideboard: ['Abrade'],
      },
    });
    expect(
      diffSnapshots(before, after).changes.map((c) => `${c.type} ${changeZones(c).join('>')} ${c.key}`),
    ).toEqual([
      'moved mainboard>considering brainstorm',
      'added mainboard preordain',
      'added sideboard abrade',
      'removed considering gitaxian probe',
      'quantity mainboard island',
      'printing mainboard ponder',
      'tags  ponder',
      'renamed  new name',
    ]);
  });

  it('is deterministic and never mutates its inputs', () => {
    const before = deepFreeze(
      buildSnapshot({ ...baseDeckSpec(), cardTags: { 'Dress Down': ['stax'] }, primer: 'a\nb\n' }),
    );
    const after = deepFreeze(
      baseWith((zones, spec) => {
        move(zones, 'Dress Down', 'mainboard', 'considering');
        add(zones, 'mainboard', 'Final Fortune');
        remove(zones, 'mainboard', 'Sol Ring');
        add(zones, 'mainboard', { name: 'Sol Ring', printings: [{ set: 'cmm', collectorNumber: '703' }] });
        spec.cardTags = { 'Dress Down': ['hate'] };
        spec.primer = 'a\nc\n';
      }),
    );
    const beforeJson = stableStringify(before);
    const afterJson = stableStringify(after);

    const first = diffSnapshots(before, after);
    const second = diffSnapshots(before, after);
    expect(second).toEqual(first);
    expect(stableStringify(second)).toBe(stableStringify(first));
    expect(stableStringify(before)).toBe(beforeJson);
    expect(stableStringify(after)).toBe(afterJson);

    // The result shares no mutable state with the (frozen) inputs.
    const printing = first.changes.find((c) => c.type === 'printing');
    expect(printing).toBeDefined();
    if (printing?.type === 'printing') {
      const [beforePrinting] = printing.before;
      expect(beforePrinting).toBeDefined();
      expect(Object.isFrozen(beforePrinting)).toBe(false);
      expect(Object.isFrozen(printing.before)).toBe(false);
    }
    expect(Object.isFrozen(first.deck)).toBe(false);
  });

  it('compareCardChanges orders moves by source, then destination', () => {
    const moved = (from: ZoneId, to: ZoneId, key = 'a'): CardChange => ({
      type: 'moved',
      key,
      name: key,
      from,
      to,
      quantity: 1,
    });
    const sorted = [
      moved('considering', 'mainboard'),
      moved('mainboard', 'sideboard', 'b'),
      moved('mainboard', 'considering'),
      moved('mainboard', 'sideboard', 'a'),
    ].sort(compareCardChanges);
    expect(sorted.map((c) => (c.type === 'moved' ? `${c.from}>${c.to} ${c.key}` : ''))).toEqual([
      'mainboard>sideboard a',
      'mainboard>sideboard b',
      'mainboard>considering a',
      'considering>mainboard a',
    ]);
  });

  it('changeTouchesZone covers both ends of a move and nothing for zoneless changes', () => {
    const moved: CardChange = {
      type: 'moved',
      key: 'a',
      name: 'A',
      from: 'commanders',
      to: 'mainboard',
      quantity: 1,
    };
    const tags: CardChange = { type: 'tags', key: 'a', name: 'A', added: ['x'], removed: [] };
    expect(changeTouchesZone(moved, 'commanders')).toBe(true);
    expect(changeTouchesZone(moved, 'mainboard')).toBe(true);
    expect(changeTouchesZone(moved, 'sideboard')).toBe(false);
    expect(changeTouchesZone(tags, 'mainboard')).toBe(false);
  });
});
