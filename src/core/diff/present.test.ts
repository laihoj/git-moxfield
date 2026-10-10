import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildSnapshot, baseDeckSpec, type CardSpec, type SnapshotSpec } from '@tests/support/builders';

import { emptySnapshot } from '../canonical';
import type { CanonicalSnapshot } from '../model';
import type { ZoneId } from '../zones';
import { diffSnapshots } from './deck-diff';
import {
  COMMIT_MESSAGE_MAX_LENGTH,
  diffChangeCount,
  groupDiffForDisplay,
  suggestCommitMessage,
  summarizeDiff,
  type DiffSection,
} from './present';
import type { CardChange, DeckDiff } from './types';

type Zones = Partial<Record<ZoneId, CardSpec[]>>;

const MINUS = '−';

function specName(card: CardSpec): string {
  return typeof card === 'string' ? card.replace(/^\d+\s+/, '') : card.name;
}

/** The base deck with an edit applied to (a copy of) its spec. */
function baseWith(mutate: (zones: Zones, spec: SnapshotSpec) => void = () => undefined): CanonicalSnapshot {
  const spec = baseDeckSpec();
  const zones: Zones = { ...spec.zones };
  mutate(zones, spec);
  return buildSnapshot({ ...spec, zones });
}

function remove(zones: Zones, zone: ZoneId, name: string): void {
  zones[zone] = (zones[zone] ?? []).filter((card) => specName(card) !== name);
}

function add(zones: Zones, zone: ZoneId, card: CardSpec): void {
  zones[zone] = [...(zones[zone] ?? []), card];
}

function diffFromBase(mutate: (zones: Zones, spec: SnapshotSpec) => void): DeckDiff {
  return diffSnapshots(baseWith(), baseWith(mutate));
}

const renamedCard = (name: string): CardSpec => ({
  name,
  ids: { moxfield: 'uniq-renamed' },
  printings: [{ set: 'iko', collectorNumber: '275' }],
});

/** A diff touching every section: commanders, two zones, a move, printings, tags and a rename. */
function richDiff(): DeckDiff {
  const before = baseWith((zones) => {
    add(zones, 'considering', renamedCard('Old Name'));
  });
  const after = baseWith((zones, spec) => {
    remove(zones, 'commanders', "Kraum, Ludevic's Opus");
    add(zones, 'mainboard', "Kraum, Ludevic's Opus");
    add(zones, 'commanders', 'Tana, the Bloodsower');
    remove(zones, 'commanders', 'Tymna the Weaver');
    add(zones, 'commanders', {
      name: 'Tymna the Weaver',
      printings: [{ set: 'c16', collectorNumber: '48' }],
    });
    add(zones, 'mainboard', 'Final Fortune');
    remove(zones, 'mainboard', 'Rhystic Study');
    remove(zones, 'mainboard', 'Island');
    add(zones, 'mainboard', '4 Island');
    remove(zones, 'mainboard', 'Dress Down');
    add(zones, 'considering', 'Dress Down');
    remove(zones, 'sideboard', 'Orcish Bowmasters');
    add(zones, 'sideboard', 'Abrade');
    remove(zones, 'mainboard', 'Sol Ring');
    add(zones, 'mainboard', { name: 'Sol Ring', printings: [{ set: 'cmm', collectorNumber: '703' }] });
    add(zones, 'considering', renamedCard('New Name'));
    spec.cardTags = { 'Dress Down': ['stax'] };
    spec.primer = "# Blue Farm\n\nWin with Thassa's Oracle or Underworld Breach.\n\n## Mulligans\n";
    spec.deck = { ...spec.deck, name: 'Blue Farm v2' };
  });
  return diffSnapshots(before, after);
}

const describeChange = (change: CardChange): string =>
  change.type === 'moved'
    ? `moved ${change.key} ${change.from}>${change.to}`
    : `${change.type} ${change.key}`;

function sectionOutline(sections: DiffSection[]) {
  return sections.map(({ changes, ...section }) => ({ ...section, changes: changes.map(describeChange) }));
}

describe('groupDiffForDisplay', () => {
  it('groups commanders first, then zones, moves, printings, tags and renames', () => {
    expect(sectionOutline(groupDiffForDisplay(richDiff()))).toEqual([
      {
        id: 'commanders',
        kind: 'commanders',
        title: 'Commanders',
        zone: 'commanders',
        changes: ["moved kraum, ludevic's opus commanders>mainboard", 'added tana, the bloodsower'],
      },
      {
        id: 'zone:mainboard',
        kind: 'zone',
        title: 'Mainboard',
        zone: 'mainboard',
        changes: ['added final fortune', 'removed rhystic study', 'quantity island'],
      },
      {
        id: 'zone:sideboard',
        kind: 'zone',
        title: 'Sideboard',
        zone: 'sideboard',
        changes: ['added abrade', 'removed orcish bowmasters'],
      },
      { id: 'moves', kind: 'moves', title: 'Moved', changes: ['moved dress down mainboard>considering'] },
      {
        id: 'printings',
        kind: 'printings',
        title: 'Printings',
        changes: ['printing tymna the weaver', 'printing sol ring'],
      },
      { id: 'tags', kind: 'tags', title: 'Card tags', changes: ['tags dress down'] },
      { id: 'renames', kind: 'renames', title: 'Renamed', changes: ['renamed new name'] },
    ]);
  });

  it('shows a commander printing change as cosmetic, without a Commanders section', () => {
    const before = baseWith((zones) => {
      remove(zones, 'commanders', 'Tymna the Weaver');
      add(zones, 'commanders', {
        name: 'Tymna the Weaver',
        printings: [{ set: 'c16', collectorNumber: '48' }],
      });
    });
    const after = baseWith((zones) => {
      remove(zones, 'commanders', 'Tymna the Weaver');
      add(zones, 'commanders', {
        name: 'Tymna the Weaver',
        printings: [{ set: 'cmr', collectorNumber: '99' }],
      });
    });
    const diff = diffSnapshots(before, after);

    expect(diff).toMatchObject({ onlyCosmetic: true, commanders: { changed: false } });
    expect(sectionOutline(groupDiffForDisplay(diff))).toEqual([
      { id: 'printings', kind: 'printings', title: 'Printings', changes: ['printing tymna the weaver'] },
    ]);
  });

  it('has a Commanders section exactly when the commanders changed', () => {
    const diffs = [
      richDiff(),
      diffFromBase((zones) => {
        remove(zones, 'commanders', 'Tymna the Weaver');
        add(zones, 'commanders', {
          name: 'Tymna the Weaver',
          printings: [{ set: 'cmr', collectorNumber: '99' }],
        });
      }),
      diffFromBase((zones) => {
        remove(zones, 'commanders', "Kraum, Ludevic's Opus");
      }),
      diffFromBase((zones) => {
        add(zones, 'mainboard', 'Final Fortune');
      }),
    ];
    for (const diff of diffs) {
      const hasSection = groupDiffForDisplay(diff).some((section) => section.kind === 'commanders');
      expect(hasSection).toBe(diff.commanders.changed);
    }
  });

  it('places every change in exactly one section, keeping diff order', () => {
    const diff = richDiff();
    const grouped = groupDiffForDisplay(diff).flatMap((section) => section.changes);
    expect(grouped).toHaveLength(diff.changes.length);
    expect(new Set(grouped)).toEqual(new Set(diff.changes));
  });

  it('omits empty sections and names other zones by label', () => {
    const diff = diffFromBase((zones) => {
      add(zones, 'other:wish-board', 'Abrade');
    });
    expect(sectionOutline(groupDiffForDisplay(diff))).toEqual([
      {
        id: 'zone:other:wish-board',
        kind: 'zone',
        title: 'Wish board',
        zone: 'other:wish-board',
        changes: ['added abrade'],
      },
    ]);
  });

  it('returns no sections for an empty diff', () => {
    expect(groupDiffForDisplay(diffSnapshots(baseWith(), baseWith()))).toEqual([]);
  });
});

describe('summarizeDiff', () => {
  it('produces chips in order: commanders, zones, moves, primer, deck info, cosmetic', () => {
    expect(summarizeDiff(richDiff())).toEqual([
      { label: 'Commanders changed', tone: 'neutral' },
      { label: '+2 Mainboard', tone: 'add' },
      { label: `${MINUS}1 Mainboard`, tone: 'remove' },
      { label: '+1 Sideboard', tone: 'add' },
      { label: `${MINUS}1 Sideboard`, tone: 'remove' },
      { label: '1 moved to Considering', tone: 'move' },
      { label: `Primer +3 / ${MINUS}1 lines`, tone: 'neutral' },
      { label: 'Deck info changed', tone: 'neutral' },
      { label: '2 printing changes', tone: 'cosmetic' },
      { label: '1 card tag change', tone: 'cosmetic' },
      { label: '1 renamed card', tone: 'cosmetic' },
    ]);
  });

  it('uses the real minus sign and aggregates moves by destination', () => {
    const diff = diffFromBase((zones) => {
      remove(zones, 'mainboard', 'Dress Down');
      remove(zones, 'mainboard', 'Rhystic Study');
      add(zones, 'considering', 'Dress Down');
      remove(zones, 'sideboard', 'Orcish Bowmasters');
      add(zones, 'considering', 'Orcish Bowmasters');
      remove(zones, 'mainboard', 'Underworld Breach');
      remove(zones, 'mainboard', "Thassa's Oracle");
      add(zones, 'mainboard', 'Beseech the Mirror');
      add(zones, 'mainboard', 'Final Fortune');
    });
    const chips = summarizeDiff(diff);
    expect(chips).toEqual([
      { label: '+2 Mainboard', tone: 'add' },
      { label: '−3 Mainboard', tone: 'remove' },
      { label: '2 moved to Considering', tone: 'move' },
    ]);
  });

  it('pluralizes cosmetic chips', () => {
    const diff = diffFromBase((zones, spec) => {
      for (const name of ['Sol Ring', 'Dress Down', 'Demonic Tutor']) {
        remove(zones, 'mainboard', name);
        add(zones, 'mainboard', { name, printings: [{ set: 'sld', collectorNumber: '1' }] });
      }
      spec.cardTags = { 'Sol Ring': ['ramp'], 'Dress Down': ['hate'] };
    });
    expect(summarizeDiff(diff)).toEqual([
      { label: '3 printing changes', tone: 'cosmetic' },
      { label: '2 card tag changes', tone: 'cosmetic' },
    ]);
  });

  it('returns no chips for an empty diff', () => {
    expect(summarizeDiff(diffSnapshots(baseWith(), baseWith()))).toEqual([]);
  });

  it('reports a primer captured after a missing one', () => {
    const before = baseWith((_zones, spec) => {
      spec.primer = null;
    });
    const diff = diffSnapshots(before, baseWith());
    expect(summarizeDiff(diff)).toEqual([{ label: 'Primer captured', tone: 'neutral' }]);
    expect(suggestCommitMessage(diff)).toBe('Capture primer');
    expect(diffChangeCount(diff)).toBe(1);
  });
});

describe('suggestCommitMessage', () => {
  it('lists additions and cuts', () => {
    const diff = diffFromBase((zones) => {
      add(zones, 'mainboard', 'Final Fortune');
      add(zones, 'mainboard', 'Beseech the Mirror');
      remove(zones, 'mainboard', 'Dress Down');
    });
    expect(suggestCommitMessage(diff)).toBe('Add Beseech the Mirror, Final Fortune; cut Dress Down');
  });

  it('describes a move', () => {
    const diff = diffFromBase((zones) => {
      remove(zones, 'mainboard', 'Dress Down');
      add(zones, 'considering', 'Dress Down');
    });
    expect(suggestCommitMessage(diff)).toBe('Move Dress Down to Considering');
  });

  it('counts quantity increases as additions', () => {
    const diff = diffFromBase((zones) => {
      remove(zones, 'mainboard', 'Island');
      add(zones, 'mainboard', '4 Island');
      add(zones, 'mainboard', 'Final Fortune');
    });
    expect(suggestCommitMessage(diff)).toBe('Add Final Fortune, Island');
  });

  it('counts quantity decreases as cuts', () => {
    const diff = diffFromBase((zones) => {
      remove(zones, 'mainboard', 'Island');
      add(zones, 'mainboard', '2 Island');
    });
    expect(suggestCommitMessage(diff)).toBe('Cut Island');
  });

  it('names the zone for additions and cuts outside the mainboard', () => {
    const diff = diffFromBase((zones) => {
      add(zones, 'sideboard', 'Abrade');
      remove(zones, 'sideboard', 'Orcish Bowmasters');
    });
    expect(suggestCommitMessage(diff)).toBe('Add Abrade to Sideboard; cut Orcish Bowmasters from Sideboard');
  });

  it('describes a commander swap, including a commander moved to the mainboard', () => {
    const swapped = diffFromBase((zones) => {
      remove(zones, 'commanders', "Kraum, Ludevic's Opus");
      add(zones, 'commanders', 'Tana, the Bloodsower');
    });
    expect(suggestCommitMessage(swapped)).toBe(
      "Swap commander Kraum, Ludevic's Opus for Tana, the Bloodsower",
    );

    const demoted = diffFromBase((zones) => {
      remove(zones, 'commanders', "Kraum, Ludevic's Opus");
      add(zones, 'mainboard', "Kraum, Ludevic's Opus");
      add(zones, 'commanders', 'Tana, the Bloodsower');
    });
    expect(suggestCommitMessage(demoted)).toBe(
      "Swap commander Kraum, Ludevic's Opus for Tana, the Bloodsower",
    );
  });

  it('describes adding or removing a commander', () => {
    const before = buildSnapshot({ zones: { commanders: ['Tymna the Weaver'], mainboard: ['Island'] } });
    const after = buildSnapshot({
      zones: { commanders: ['Tymna the Weaver', 'Tana, the Bloodsower'], mainboard: ['Island'] },
    });
    expect(suggestCommitMessage(diffSnapshots(before, after))).toBe('Add commander Tana, the Bloodsower');
    expect(suggestCommitMessage(diffSnapshots(after, before))).toBe('Remove commander Tana, the Bloodsower');
  });

  it('describes primer, deck info and cosmetic-only changes', () => {
    expect(
      suggestCommitMessage(
        diffFromBase((_zones, spec) => {
          spec.primer = '# Updated\n';
        }),
      ),
    ).toBe('Update primer');
    expect(
      suggestCommitMessage(
        diffFromBase((_zones, spec) => {
          spec.deck = { ...spec.deck, name: 'Blue Farm v2', tags: ['cEDH', 'Turbo'] };
        }),
      ),
    ).toBe('Rename deck; update deck tags');
    expect(
      suggestCommitMessage(
        diffFromBase((zones) => {
          remove(zones, 'mainboard', 'Sol Ring');
          add(zones, 'mainboard', { name: 'Sol Ring', printings: [{ set: 'cmm', collectorNumber: '703' }] });
        }),
      ),
    ).toBe('Change printings');
    expect(
      suggestCommitMessage(
        diffFromBase((_zones, spec) => {
          spec.cardTags = { 'Sol Ring': ['ramp'] };
        }),
      ),
    ).toBe('Update card tags');
    const renamed = diffSnapshots(
      buildSnapshot({ zones: { mainboard: [renamedCard('Old Name')] } }),
      buildSnapshot({ zones: { mainboard: [renamedCard('New Name')] } }),
    );
    expect(suggestCommitMessage(renamed)).toBe('Update card names');
  });

  it('appends primer and deck info clauses after card changes', () => {
    const diff = diffFromBase((zones, spec) => {
      add(zones, 'mainboard', 'Final Fortune');
      spec.primer = '# Updated\n';
    });
    expect(suggestCommitMessage(diff)).toBe('Add Final Fortune; update primer');
  });

  it('truncates long name lists with "+N more"', () => {
    const diff = diffFromBase((zones) => {
      for (const name of [
        'Mox Diamond',
        "Lion's Eye Diamond",
        'Gemstone Caverns',
        'Final Fortune',
        'Dark Ritual',
        'Chrome Mox',
        'Beseech the Mirror',
        'Ad Nauseam',
      ]) {
        add(zones, 'mainboard', name);
      }
    });
    expect(suggestCommitMessage(diff)).toBe(
      'Add Ad Nauseam, Beseech the Mirror, Chrome Mox, Dark Ritual +4 more',
    );
  });

  it('drops trailing clauses that do not fit, keeping as many names as possible', () => {
    const diff = diffFromBase((zones) => {
      remove(zones, 'mainboard', 'Island');
      add(zones, 'mainboard', '4 Island');
      add(zones, 'mainboard', 'Final Fortune');
      add(zones, 'considering', 'Necropotence');
      remove(zones, 'considering', 'Peer into the Abyss');
    });
    expect(suggestCommitMessage(diff)).toBe('Add Final Fortune, Island; add Necropotence to Considering');
    expect(suggestCommitMessage(richDiff())).toBe(
      "Swap commander Kraum, Ludevic's Opus for Tana, the Bloodsower",
    );
  });

  it('hard-truncates a single overlong clause with an ellipsis', () => {
    const name = `${'Very '.repeat(20)}Long Card`;
    const message = suggestCommitMessage(
      diffFromBase((zones) => {
        add(zones, 'mainboard', name);
      }),
    );
    expect(message).toHaveLength(COMMIT_MESSAGE_MAX_LENGTH);
    expect(message.startsWith('Add Very Very')).toBe(true);
    expect(message.endsWith('…')).toBe(true);
  });

  it('returns an empty string for an empty diff', () => {
    expect(suggestCommitMessage(diffSnapshots(baseWith(), baseWith()))).toBe('');
  });

  it('is never longer than the limit and empty only for empty diffs', () => {
    const names = [
      'Island',
      'Sol Ring',
      'Dress Down',
      'Lion’s Eye Diamond',
      'Thassa’s Oracle',
      'Tymna the Weaver',
    ];
    const zonesArb = fc.dictionary(
      fc.constantFrom<ZoneId>('commanders', 'mainboard', 'sideboard', 'considering'),
      fc.subarray(names).map((cards) => cards.map((card, i) => `${(i % 3) + 1} ${card}`)),
    );
    const snapshotArb = fc
      .record({ zones: zonesArb, primer: fc.constantFrom('', 'a\n', null), name: fc.constantFrom('A', 'B') })
      .map(({ zones, primer, name }) => buildSnapshot({ zones, primer, deck: { name } }));
    fc.assert(
      fc.property(snapshotArb, snapshotArb, (before, after) => {
        const diff = diffSnapshots(before, after);
        const message = suggestCommitMessage(diff);
        expect(message.length).toBeLessThanOrEqual(COMMIT_MESSAGE_MAX_LENGTH);
        expect(message === '').toBe(diff.isEmpty);
        expect(suggestCommitMessage(diffSnapshots(before, after))).toBe(message);
      }),
      { seed: 20261009, numRuns: 200 },
    );
  });
});

describe('diffChangeCount', () => {
  it('counts card changes, deck info fields and the primer', () => {
    const diff = richDiff();
    expect(diff.changes).toHaveLength(12);
    expect(diff.deck).toHaveLength(1);
    expect(diffChangeCount(diff)).toBe(14);
  });

  it('is zero for an empty diff and ignores an unknown primer', () => {
    expect(diffChangeCount(diffSnapshots(baseWith(), baseWith()))).toBe(0);
    const unknownPrimer = diffSnapshots(emptySnapshot({ name: 'A' }), {
      ...emptySnapshot({ name: 'A' }),
      primer: null,
    });
    expect(unknownPrimer.primer).toEqual({ status: 'unknown' });
    expect(diffChangeCount(unknownPrimer)).toBe(0);
  });
});
