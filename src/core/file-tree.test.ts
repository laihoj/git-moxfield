import { describe, expect, it } from 'vitest';

import { buildCard, buildSnapshot, type SnapshotSpec } from '@tests/support/builders';

import { compareStrings, emptySnapshot } from './canonical';
import { cardLines, printingLine, snapshotToFileTree, zoneFileName } from './file-tree';
import type { CanonicalPrinting } from './model';
import { KNOWN_ZONES } from './zones';

function p(overrides: Partial<CanonicalPrinting> = {}): CanonicalPrinting {
  return {
    set: 'cmm',
    collectorNumber: '703',
    finish: 'nonfoil',
    lang: 'en',
    quantity: 1,
    ids: {},
    ...overrides,
  };
}

const smallDeck: SnapshotSpec = {
  deck: {
    name: 'Blue "Farm"',
    format: 'commander',
    description: 'Line one\nLine two',
    tags: ['cEDH', 'Turbo'],
  },
  zones: {
    commanders: [
      { name: 'Tymna the Weaver', printings: [{ set: 'c16', collectorNumber: '48', finish: 'foil' }] },
      { name: "Kraum, Ludevic's Opus", printings: [{ set: 'c16', collectorNumber: '28', finish: 'etched' }] },
    ],
    signatureSpells: [{ name: 'Brainstorm', printings: [{ set: 'ice', collectorNumber: '61', lang: 'ja' }] }],
    mainboard: [
      { name: 'Sol Ring', printings: [{ set: 'cmm', collectorNumber: '703', finish: 'galaxy' }] },
      { name: 'Life // Death', quantity: 2, noPrintings: true },
      {
        name: 'Island',
        printings: [
          { set: 'ltr', collectorNumber: '716', flags: ['proxy', 'alter'] },
          { set: 'ltr', collectorNumber: '715', quantity: 2 },
        ],
      },
    ],
    considering: [{ name: 'Dress Down', printings: [{ set: 'mh1', collectorNumber: '39' }] }],
    'other:foo': [{ name: 'Mox Opal', printings: [{ set: 'som', collectorNumber: '179' }] }],
  },
  cardTags: { 'Dress Down': ['stax', 'hate'], 'Sol Ring': ['ramp'], 'Ghost Card': ['gone'] },
  primer: '# Blue Farm\n\nWin.\n',
};

describe('snapshotToFileTree', () => {
  it('renders the exact file tree of a small deck', () => {
    expect(snapshotToFileTree(buildSnapshot(smallDeck))).toStrictEqual({
      // Card tags by key; tags of cards no longer in the deck fall back to the key.
      'card-tags.txt': 'Dress Down: hate, stax\nghost card: gone\nSol Ring: ramp\n',
      'commanders.txt': "1 Kraum, Ludevic's Opus (C16) 28 *E*\n1 Tymna the Weaver (C16) 48 *F*\n",
      'considering.txt': '1 Dress Down (MH1) 39\n',
      'deck.yaml': [
        'schema: 1',
        'name: "Blue \\"Farm\\""',
        'format: "commander"',
        'description: "Line one\\nLine two"',
        'tags:',
        '  - "Turbo"',
        '  - "cEDH"',
        'primer: primer.md',
        '',
      ].join('\n'),
      'mainboard.txt': [
        '2 Island (LTR) 715',
        '1 Island (LTR) 716 {alter,proxy}',
        '2 Life // Death',
        '1 Sol Ring (CMM) 703 *galaxy*',
        '',
      ].join('\n'),
      'other-foo.txt': '1 Mox Opal (SOM) 179\n',
      'primer.md': '# Blue Farm\n\nWin.\n',
      'signature-spells.txt': '1 Brainstorm (ICE) 61 [ja]\n',
    });
  });

  it('orders paths ordinally', () => {
    const paths = Object.keys(snapshotToFileTree(buildSnapshot(smallDeck)));
    expect(paths).toEqual([...paths].sort(compareStrings));
    expect(paths).toEqual([
      'card-tags.txt',
      'commanders.txt',
      'considering.txt',
      'deck.yaml',
      'mainboard.txt',
      'other-foo.txt',
      'primer.md',
      'signature-spells.txt',
    ]);
  });

  it('is deterministic for semantically identical snapshots', () => {
    const reordered: SnapshotSpec = {
      ...smallDeck,
      deck: { ...smallDeck.deck, tags: ['Turbo', 'cEDH', 'Turbo'] },
      zones: Object.fromEntries(Object.entries(smallDeck.zones ?? {}).reverse()),
      cardTags: { 'sol ring': ['ramp'], 'ghost card': ['gone'], 'dress down': ['hate', 'stax'] },
    };
    expect(snapshotToFileTree(buildSnapshot(reordered))).toStrictEqual(
      snapshotToFileTree(buildSnapshot(smallDeck)),
    );
  });

  it('uses LF line endings and ends every file with a newline', () => {
    for (const content of Object.values(snapshotToFileTree(buildSnapshot(smallDeck)))) {
      expect(content).not.toContain('\r');
      expect(content.endsWith('\n')).toBe(true);
    }
  });

  it('renders the empty deck as deck.yaml only', () => {
    expect(snapshotToFileTree(emptySnapshot())).toStrictEqual({
      'deck.yaml': 'schema: 1\nname: ""\nformat: ""\ndescription: ""\ntags: []\nprimer: none\n',
    });
  });

  it.each<[string | null, string, boolean]>([
    ['# Primer\n', 'primer.md', true],
    ['', 'none', false],
    [null, 'unavailable', false],
  ])('handles primer %j: deck.yaml says %s, primer.md present: %s', (primer, status, present) => {
    const tree = snapshotToFileTree(buildSnapshot({ primer }));
    expect(tree['deck.yaml']).toContain(`\nprimer: ${status}\n`);
    expect('primer.md' in tree).toBe(present);
    if (primer) expect(tree['primer.md']).toBe(primer);
  });

  it.each<[string | null, string, string | undefined]>([
    [null, 'unavailable', 'Last captured\n'],
    ['', 'none', undefined],
    ['# Primer\n', 'primer.md', '# Primer\n'],
  ])(
    'with an unknownPrimer, handles primer %j: deck.yaml says %s, primer.md is %j',
    (primer, status, content) => {
      const tree = snapshotToFileTree(buildSnapshot({ primer }), { unknownPrimer: 'Last captured\n' });
      expect(tree['deck.yaml']).toContain(`\nprimer: ${status}\n`);
      expect(tree['primer.md']).toBe(content);
    },
  );

  it('writes no primer.md for an uncaptured primer when the unknownPrimer is empty', () => {
    expect(snapshotToFileTree(buildSnapshot({ primer: null }), { unknownPrimer: '' })).not.toHaveProperty(
      'primer.md',
    );
  });

  it('omits card-tags.txt when no card has tags', () => {
    expect(snapshotToFileTree(buildSnapshot({ zones: { mainboard: ['Island'] } }))).not.toHaveProperty(
      'card-tags.txt',
    );
  });

  it('quotes deck.yaml scalars so any text round-trips', () => {
    const snapshot = buildSnapshot({
      deck: {
        name: 'Weird: "name" \\ with\ttabs\nand # comments',
        description: '- not a list\nnull',
        tags: ['yes', 'a: b'],
      },
    });
    const lines = snapshotToFileTree(snapshot)['deck.yaml']?.split('\n') ?? [];
    const scalar = (prefix: string): unknown => {
      const line = lines.find((l) => l.startsWith(prefix)) ?? '';
      return JSON.parse(line.slice(prefix.length));
    };

    expect(snapshot.deck.name).toContain('\n');
    expect(scalar('name: ')).toBe(snapshot.deck.name);
    expect(scalar('description: ')).toBe('- not a list\nnull');
    expect(lines.filter((l) => l.startsWith('  - ')).map((l) => JSON.parse(l.slice(4)) as unknown)).toEqual([
      'a: b',
      'yes',
    ]);
  });

  it('escapes characters YAML readers reject or fold, so deck.yaml stays loadable', () => {
    // DEL, C1 controls (cp1252 smart quotes read as Latin-1), NEL, LS, PS, BOM,
    // noncharacters, and a lone surrogate (a truncated emoji); emoji pairs stay as they are.
    const awkward =
      'a\u007fb \u0093q\u0094 n\u0085l s\u2028p\u2029b\ufeffo \ufffe\uffff x\ud83d y \ud83d\ude00 z';
    const snapshot = buildSnapshot({
      deck: { name: `Name ${awkward}`, description: `Description ${awkward}`, tags: ['Tag\u0080x'] },
    });
    const yaml = snapshotToFileTree(snapshot)['deck.yaml'] ?? '';

    // YAML 1.2 c-printable, minus NEL (a line break for YAML 1.1 readers).
    const notPrintable = /[^\t\n\r\x20-\x7E\u00A0-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
    expect(yaml).not.toMatch(notPrintable);
    // Allowed in quoted scalars, but YAML 1.1 readers fold LS/PS and BOMs should be escaped.
    expect(yaml).not.toMatch(/[\u2028\u2029\uFEFF]/);
    // An escaped surrogate is never a valid YAML (or Unicode) scalar value.
    expect(yaml).not.toMatch(/\\u[dD][89a-fA-F]/);
    expect(yaml).toContain('\ud83d\ude00');

    const lines = yaml.split('\n');
    const scalar = (prefix: string): unknown =>
      JSON.parse((lines.find((l) => l.startsWith(prefix)) ?? '').slice(prefix.length));
    const expected = awkward.replace('x\ud83d y', 'x\ufffd y');
    expect(scalar('name: ')).toBe(`Name ${expected}`);
    expect(scalar('description: ')).toBe(`Description ${expected}`);
    expect(scalar('  - ')).toBe('Tag\u0080x');
  });
});

describe('zoneFileName', () => {
  it('kebab-cases known zones', () => {
    expect(KNOWN_ZONES.map(zoneFileName)).toEqual([
      'commanders.txt',
      'companions.txt',
      'signature-spells.txt',
      'mainboard.txt',
      'sideboard.txt',
      'considering.txt',
      'attractions.txt',
      'stickers.txt',
      'contraptions.txt',
      'planes.txt',
      'schemes.txt',
      'tokens.txt',
    ]);
  });

  it('prefixes other zones so they never collide with known zones or fixed files', () => {
    expect(zoneFileName('other:foo')).toBe('other-foo.txt');
    expect(zoneFileName('other:foo-bar')).toBe('other-foo-bar.txt');
    const known = new Set(KNOWN_ZONES.map(zoneFileName));
    for (const zone of ['other:mainboard', 'other:deck', 'other:card-tags', 'other:primer'] as const) {
      expect(known.has(zoneFileName(zone))).toBe(false);
      expect(['deck.yaml', 'card-tags.txt', 'primer.md']).not.toContain(zoneFileName(zone));
    }
  });
});

describe('printingLine', () => {
  const sol = { name: 'Sol Ring' };

  it.each<[Partial<CanonicalPrinting>, string]>([
    [{}, '1 Sol Ring (CMM) 703'],
    [{ quantity: 3 }, '3 Sol Ring (CMM) 703'],
    [{ finish: 'foil' }, '1 Sol Ring (CMM) 703 *F*'],
    [{ finish: 'etched' }, '1 Sol Ring (CMM) 703 *E*'],
    [{ finish: 'galaxy' }, '1 Sol Ring (CMM) 703 *galaxy*'],
    [{ lang: 'ja' }, '1 Sol Ring (CMM) 703 [ja]'],
    [{ flags: ['alter', 'proxy'] }, '1 Sol Ring (CMM) 703 {alter,proxy}'],
    [{ flags: [] }, '1 Sol Ring (CMM) 703'],
    [{ set: 'plst', collectorNumber: 'C21-263' }, '1 Sol Ring (PLST) C21-263'],
    [{ finish: 'foil', lang: 'de', flags: ['proxy'] }, '1 Sol Ring (CMM) 703 *F* [de] {proxy}'],
  ])('renders %j as %j', (overrides, expected) => {
    expect(printingLine(sol, p(overrides))).toBe(expected);
  });
});

describe('cardLines', () => {
  it('renders one line per printing', () => {
    const island = buildCard({
      name: 'Island',
      printings: [
        { set: 'ltr', collectorNumber: '715', quantity: 2 },
        { set: 'ltr', collectorNumber: '716', finish: 'foil' },
      ],
    });
    expect(cardLines(island)).toEqual(['2 Island (LTR) 715', '1 Island (LTR) 716 *F*']);
  });

  it('renders quantity and name for cards without printings', () => {
    expect(cardLines(buildCard({ name: 'Life // Death', quantity: 3, noPrintings: true }))).toEqual([
      '3 Life // Death',
    ]);
  });
});
