import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  allCards,
  cardName,
  cardNames,
  cardZoneIndex,
  cardZones,
  CanonicalizationError,
  canonicalizeSnapshot,
  compareStrings,
  emptySnapshot,
  normalizePrimer,
  normalizeTagList,
  normalizeText,
  printingIdentity,
  stableStringify,
} from './canonical';
import { snapshotHash } from './hash';
import type { CanonicalCard, CanonicalPrinting, CanonicalSnapshot, CardIdentityIds, ZoneMap } from './model';
import type { ZoneId } from './zones';

// Raw (non-canonical) inputs are written as explicit literals on purpose: these tests
// pin the canonicalizer itself, so they must not go through the test builders.

function raw(overrides: Partial<CanonicalSnapshot> = {}): CanonicalSnapshot {
  return {
    schemaVersion: 1,
    deck: { name: 'Deck', format: 'commander', description: '', tags: [] },
    zones: {},
    cardTags: {},
    primer: '',
    ...overrides,
  };
}

function printing(
  set: string,
  collectorNumber: string,
  quantity = 1,
  extra: Partial<CanonicalPrinting> = {},
): CanonicalPrinting {
  return { set, collectorNumber, finish: 'nonfoil', lang: 'en', quantity, ids: {}, ...extra };
}

/** A raw card entry. The key is deliberately bogus: canonicalization derives it from the name. */
function card(
  name: string,
  quantity: number,
  printings: CanonicalPrinting[] = [],
  ids: CardIdentityIds = {},
): CanonicalCard {
  return { key: 'not-a-real-key', name, quantity, printings, ids };
}

function canonicalPrintingsOf(input: CanonicalSnapshot, zone: ZoneId = 'mainboard'): CanonicalPrinting[] {
  return canonicalizeSnapshot(input).zones[zone]?.[0]?.printings ?? [];
}

function collectorNumbersSorted(numbers: string[]): string[] {
  return canonicalPrintingsOf(
    raw({
      zones: {
        mainboard: [
          card(
            'X',
            numbers.length,
            numbers.map((cn) => printing('set', cn)),
          ),
        ],
      },
    }),
  ).map((p) => p.collectorNumber);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('canonicalizeSnapshot', () => {
  const messy = raw({
    deck: {
      name: '  Blue Farm \r\n',
      format: ' Commander ',
      description: 'Line one\r\nLine two  \r\n\r\n',
      tags: [' cEDH ', 'Turbo', 'cEDH', '', 'Blue  Farm'],
    },
    zones: {
      sideboard: [card('Orcish Bowmasters', 1, [printing('LTR', '103')])],
      mainboard: [
        card('Island', 2, [printing('ltr', '715', 2)]),
        card('Sol Ring', 1, [printing('CMM', '703', 1, { ids: { scryfall: 'sr-1', moxfield: '' } })], {
          moxfield: 'sol-mox',
        }),
        card(' island ', 1, [printing('ltr', '715', 1, { ids: { scryfall: 'isl-715' } })]),
      ],
      commanders: [card('Tymna the Weaver', 1, [printing('c16', '48', 1, { finish: 'Foil' })])],
      considering: [],
    },
    cardTags: { 'Sol Ring': ['ramp', ' ramp ', 'artifact'], Island: [] },
    primer: '# Primer  \r\n\r\nBody\r\n\r\n  ',
  });

  it('produces the canonical form of a messy snapshot', () => {
    expect(canonicalizeSnapshot(messy)).toStrictEqual({
      schemaVersion: 1,
      deck: {
        name: 'Blue Farm',
        format: 'commander',
        description: 'Line one\nLine two',
        tags: ['Blue Farm', 'Turbo', 'cEDH'],
      },
      zones: {
        commanders: [
          {
            key: 'tymna the weaver',
            name: 'Tymna the Weaver',
            quantity: 1,
            printings: [
              { set: 'c16', collectorNumber: '48', finish: 'foil', lang: 'en', quantity: 1, ids: {} },
            ],
            ids: {},
          },
        ],
        mainboard: [
          {
            key: 'island',
            name: 'Island',
            quantity: 3,
            printings: [
              {
                set: 'ltr',
                collectorNumber: '715',
                finish: 'nonfoil',
                lang: 'en',
                quantity: 3,
                ids: { scryfall: 'isl-715' },
              },
            ],
            ids: {},
          },
          {
            key: 'sol ring',
            name: 'Sol Ring',
            quantity: 1,
            printings: [
              {
                set: 'cmm',
                collectorNumber: '703',
                finish: 'nonfoil',
                lang: 'en',
                quantity: 1,
                ids: { scryfall: 'sr-1' },
              },
            ],
            ids: { moxfield: 'sol-mox' },
          },
        ],
        sideboard: [
          {
            key: 'orcish bowmasters',
            name: 'Orcish Bowmasters',
            quantity: 1,
            printings: [
              { set: 'ltr', collectorNumber: '103', finish: 'nonfoil', lang: 'en', quantity: 1, ids: {} },
            ],
            ids: {},
          },
        ],
      },
      cardTags: { 'sol ring': ['artifact', 'ramp'] },
      primer: '# Primer  \n\nBody\n',
    });
  });

  it('emits zones in canonical order regardless of input order', () => {
    expect(Object.keys(canonicalizeSnapshot(messy).zones)).toEqual(['commanders', 'mainboard', 'sideboard']);
  });

  it('is idempotent', () => {
    const once = canonicalizeSnapshot(messy);
    const twice = canonicalizeSnapshot(once);
    expect(twice).toStrictEqual(once);
    expect(stableStringify(twice)).toBe(stableStringify(once));
  });

  it('does not mutate its input', () => {
    const input = deepFreeze(structuredClone(messy));
    expect(() => canonicalizeSnapshot(input)).not.toThrow();
    expect(input).toStrictEqual(messy);
  });

  it('forces the current schema version', () => {
    const input = { ...raw(), schemaVersion: 999 } as unknown as CanonicalSnapshot;
    expect(canonicalizeSnapshot(input).schemaVersion).toBe(1);
  });

  describe('cards', () => {
    it('derives the key from the normalized name, ignoring the input key', () => {
      const result = canonicalizeSnapshot(
        raw({ zones: { mainboard: [card('  Thassa\u2019s   Oracle ', 1), card('Life//Death', 1)] } }),
      );
      expect(result.zones.mainboard?.map((c) => [c.key, c.name])).toEqual([
        ['life // death', 'Life // Death'],
        ["thassa's oracle", "Thassa's Oracle"],
      ]);
    });

    it('NFC-normalizes names', () => {
      const result = canonicalizeSnapshot(
        raw({ zones: { mainboard: [card('Lim-Du\u0302l the Necromancer', 1)] } }),
      );
      expect(result.zones.mainboard?.[0]?.name).toBe('Lim-D\u00fbl the Necromancer');
    });

    it('sorts cards by key (ordinal)', () => {
      const result = canonicalizeSnapshot(
        raw({ zones: { mainboard: [card('Zuran Orb', 1), card('ad nauseam', 1), card('Brainstorm', 1)] } }),
      );
      expect(result.zones.mainboard?.map((c) => c.key)).toEqual(['ad nauseam', 'brainstorm', 'zuran orb']);
    });

    it('merges duplicate entries of the same printing by summing quantities', () => {
      const result = canonicalizeSnapshot(
        raw({
          zones: {
            mainboard: [
              card('Island', 2, [printing('ltr', '715', 2, { ids: { scryfall: 'first' } })], {
                moxfield: 'm-1',
              }),
              card(
                'ISLAND',
                3,
                [printing('LTR', '715', 3, { ids: { scryfall: 'second', moxfield: 'p-2' } })],
                {
                  moxfield: 'm-2',
                  scryfallOracle: 'o-2',
                },
              ),
            ],
          },
        }),
      );
      expect(result.zones.mainboard).toStrictEqual([
        {
          key: 'island',
          name: 'Island', // first entry wins
          quantity: 5,
          printings: [
            {
              set: 'ltr',
              collectorNumber: '715',
              finish: 'nonfoil',
              lang: 'en',
              quantity: 5,
              ids: { moxfield: 'p-2', scryfall: 'first' }, // first non-empty value per id wins
            },
          ],
          ids: { moxfield: 'm-1', scryfallOracle: 'o-2' },
        },
      ]);
    });

    it('keeps different printings of a merged card, sorted', () => {
      const result = canonicalizeSnapshot(
        raw({
          zones: {
            mainboard: [
              card('Island', 1, [printing('ltr', '716')]),
              card('Island', 2, [printing('dmu', '262', 1), printing('ltr', '715', 1)]),
            ],
          },
        }),
      );
      expect(result.zones.mainboard?.[0]?.quantity).toBe(3);
      expect(result.zones.mainboard?.[0]?.printings.map((p) => `${p.set}/${p.collectorNumber}`)).toEqual([
        'dmu/262',
        'ltr/715',
        'ltr/716',
      ]);
    });

    it('keeps the same card in different zones apart', () => {
      const result = canonicalizeSnapshot(
        raw({ zones: { considering: [card('Dress Down', 1)], mainboard: [card('Dress Down', 1)] } }),
      );
      expect(result.zones.mainboard?.map((c) => c.key)).toEqual(['dress down']);
      expect(result.zones.considering?.map((c) => c.key)).toEqual(['dress down']);
    });

    it('accepts cards without printing information', () => {
      const result = canonicalizeSnapshot(raw({ zones: { mainboard: [card('Island', 7)] } }));
      expect(result.zones.mainboard).toStrictEqual([
        { key: 'island', name: 'Island', quantity: 7, printings: [], ids: {} },
      ]);
    });

    it('drops empty zones', () => {
      const result = canonicalizeSnapshot(
        raw({ zones: { mainboard: [], considering: undefined, sideboard: [card('Island', 1)] } }),
      );
      expect(Object.keys(result.zones)).toEqual(['sideboard']);
    });

    it('drops empty and non-string ids and orders id keys', () => {
      const ids = { scryfallOracle: 'o-1', moxfield: '', extra: 42 } as unknown as CardIdentityIds;
      const result = canonicalizeSnapshot(
        raw({
          zones: {
            mainboard: [
              card('Island', 1, [printing('ltr', '715', 1, { ids: { scryfall: '', moxfield: 'p-1' } })], ids),
            ],
          },
        }),
      );
      const island = result.zones.mainboard?.[0];
      expect(island?.ids).toStrictEqual({ scryfallOracle: 'o-1' });
      expect(island?.printings[0]?.ids).toStrictEqual({ moxfield: 'p-1' });
    });

    it('tolerates missing id objects', () => {
      const input = raw({ zones: { mainboard: [card('Island', 1)] } });
      const mainboard = input.zones.mainboard ?? [];
      Reflect.deleteProperty(mainboard[0] ?? {}, 'ids');
      expect(canonicalizeSnapshot(input).zones.mainboard?.[0]?.ids).toStrictEqual({});
    });
  });

  describe('printings', () => {
    it('normalizes printing fields and flags', () => {
      const [p] = canonicalPrintingsOf(
        raw({
          zones: {
            mainboard: [
              card('Sol Ring', 1, [
                {
                  set: ' CMM ',
                  collectorNumber: ' OTC-252 ',
                  finish: 'Galaxy',
                  lang: 'JA',
                  quantity: 1,
                  flags: ['Proxy', 'alter', 'proxy', ' '],
                  ids: {},
                },
              ]),
            ],
          },
        }),
      );
      expect(p).toStrictEqual({
        set: 'cmm',
        collectorNumber: 'OTC-252',
        finish: 'galaxy',
        lang: 'ja',
        quantity: 1,
        flags: ['alter', 'proxy'],
        ids: {},
      });
    });

    it('omits empty flag lists', () => {
      const [p] = canonicalPrintingsOf(
        raw({ zones: { mainboard: [card('Sol Ring', 1, [printing('cmm', '703', 1, { flags: [' '] })])] } }),
      );
      expect(p).not.toHaveProperty('flags');
    });

    it('sorts by set, then collector number naturally', () => {
      expect(
        canonicalPrintingsOf(
          raw({
            zones: {
              mainboard: [
                card('Island', 4, [
                  printing('ltr', '2'),
                  printing('dmu', '10'),
                  printing('ltr', '10'),
                  printing('dmu', '2'),
                ]),
              ],
            },
          }),
        ).map((p) => `${p.set}/${p.collectorNumber}`),
      ).toEqual(['dmu/2', 'dmu/10', 'ltr/2', 'ltr/10']);
    });

    it('orders collector numbers naturally: number first, then suffix, then ordinal', () => {
      expect(
        collectorNumbersSorted(['10a', 'OTC-252', '2', '1492\u2605', '10', '010', '1492', '1', '*5']),
      ).toEqual([
        '*5', // ordinal: '*' sorts before digits
        '1',
        '2',
        '010', // same value as 10; ordinal tie-break
        '10',
        '10a',
        '1492',
        '1492\u2605', // 1492★
        'OTC-252', // ordinal: letters sort after digits
      ]);
    });

    it('compares long collector numbers exactly', () => {
      expect(collectorNumbersSorted(['09007199254740993', '9007199254740992'])).toEqual([
        '9007199254740992',
        '09007199254740993',
      ]);
    });

    it('orders printings independently of input order (total order)', () => {
      // Regression: a digit-led number containing a line break used to fall back to an
      // ordinal comparison, making the comparator intransitive.
      const numbers = ['12\nx', '3', '100'];
      const expected = ['3', '12\nx', '100'];
      for (const order of [numbers, [...numbers].reverse(), ['3', '12\nx', '100'], ['100', '3', '12\nx']]) {
        expect(collectorNumbersSorted(order)).toEqual(expected);
      }

      fc.assert(
        fc.property(
          fc
            .uniqueArray(
              fc.oneof(fc.stringMatching(/^\d{1,3}[a-z\u2605\n-]?$/), fc.string({ minLength: 1 })),
              {
                minLength: 1,
                maxLength: 8,
                selector: (cn) => cn.trim(),
              },
            )
            .filter((cns) => cns.every((cn) => cn.trim().length > 0)),
          fc.nat(),
          (cns, seed) => {
            const rotated = [...cns.slice(seed % cns.length), ...cns.slice(0, seed % cns.length)];
            expect(collectorNumbersSorted(rotated)).toEqual(collectorNumbersSorted([...cns].reverse()));
          },
        ),
      );
    });

    it('breaks ties by finish, language and flags', () => {
      expect(
        canonicalPrintingsOf(
          raw({
            zones: {
              mainboard: [
                card('Island', 6, [
                  printing('ltr', '715', 1, { finish: 'nonfoil' }),
                  printing('ltr', '715', 1, { finish: 'foil', flags: ['proxy'] }),
                  printing('ltr', '715', 1, { finish: 'foil', flags: ['alter', 'proxy'] }),
                  printing('ltr', '715', 1, { finish: 'foil' }),
                  printing('ltr', '715', 1, { finish: 'etched' }),
                  printing('ltr', '715', 1, { finish: 'foil', lang: 'de' }),
                ]),
              ],
            },
          }),
        ).map((p) => [p.finish, p.lang, (p.flags ?? []).join(',')]),
      ).toEqual([
        ['etched', 'en', ''],
        ['foil', 'de', ''],
        ['foil', 'en', ''],
        ['foil', 'en', 'alter,proxy'],
        ['foil', 'en', 'proxy'],
        ['nonfoil', 'en', ''],
      ]);
    });

    it('merges printings by identity, ignoring source ids', () => {
      const printings = canonicalPrintingsOf(
        raw({
          zones: {
            mainboard: [
              card('Island', 3, [
                printing('ltr', '715', 1, { flags: ['proxy'], ids: { scryfall: 'a' } }),
                printing('LTR', '715', 2, { flags: ['PROXY'], ids: { scryfall: 'b' } }),
              ]),
            ],
          },
        }),
      );
      expect(printings).toStrictEqual([
        {
          set: 'ltr',
          collectorNumber: '715',
          finish: 'nonfoil',
          lang: 'en',
          quantity: 3,
          flags: ['proxy'],
          ids: { scryfall: 'a' },
        },
      ]);
    });
  });

  describe('validation', () => {
    const cases: [string, CanonicalSnapshot][] = [
      ['an unknown zone id', raw({ zones: { maybeboard: [card('Island', 1)] } as unknown as ZoneMap })],
      [
        'a malformed other zone id',
        raw({ zones: { 'other:Foo': [card('Island', 1)] } as unknown as ZoneMap }),
      ],
      ['a zero quantity', raw({ zones: { mainboard: [card('Island', 0)] } })],
      ['a negative quantity', raw({ zones: { mainboard: [card('Island', -1)] } })],
      ['a fractional quantity', raw({ zones: { mainboard: [card('Island', 1.5)] } })],
      ['a NaN quantity', raw({ zones: { mainboard: [card('Island', Number.NaN)] } })],
      ['an infinite quantity', raw({ zones: { mainboard: [card('Island', Number.POSITIVE_INFINITY)] } })],
      ['an unsafe integer quantity', raw({ zones: { mainboard: [card('Island', 2 ** 53)] } })],
      [
        'a zero printing quantity',
        raw({ zones: { mainboard: [card('Island', 1, [printing('ltr', '715', 0)])] } }),
      ],
      [
        'a fractional printing quantity',
        raw({ zones: { mainboard: [card('Island', 1, [printing('ltr', '715', 0.5)])] } }),
      ],
      [
        'printing quantities that do not add up',
        raw({ zones: { mainboard: [card('Island', 2, [printing('ltr', '715', 1)])] } }),
      ],
      [
        'merged entries with and without printings',
        raw({ zones: { mainboard: [card('Island', 1, [printing('ltr', '715', 1)]), card('Island', 1)] } }),
      ],
      ['an empty name', raw({ zones: { mainboard: [card('', 1)] } })],
      ['a whitespace-only name', raw({ zones: { mainboard: [card(' \t ', 1)] } })],
    ];

    it.each(cases)('rejects %s', (_, input) => {
      expect(() => canonicalizeSnapshot(input)).toThrow(CanonicalizationError);
    });

    it('reports errors as named CanonicalizationErrors with context', () => {
      let error: unknown;
      try {
        canonicalizeSnapshot(raw({ zones: { mainboard: [card('Island', 2, [printing('ltr', '715', 1)])] } }));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(CanonicalizationError);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('CanonicalizationError');
      expect((error as Error).message).toBe(
        'Printing quantities of Island in mainboard sum to 1, expected 2',
      );
    });
  });

  describe('deck info and text', () => {
    it('trims and NFC-normalizes the name and lowercases the format', () => {
      const result = canonicalizeSnapshot(
        raw({ deck: { name: ' Lim-Du\u0302l Control ', format: ' Commander ', description: '', tags: [] } }),
      );
      expect(result.deck.name).toBe('Lim-D\u00fbl Control');
      expect(result.deck.format).toBe('commander');
    });

    it.each([
      ['Blurb', 'Blurb'],
      ['Blurb  \r\n\r\n', 'Blurb'],
      ['Line one\r\nLine two\rLine three', 'Line one\nLine two\nLine three'],
      ['  Leading whitespace is kept', '  Leading whitespace is kept'],
      [' \n ', ''],
      ['', ''],
    ])('normalizes the description %j to %j', (description, expected) => {
      const result = canonicalizeSnapshot(raw({ deck: { name: 'D', format: 'f', description, tags: [] } }));
      expect(result.deck.description).toBe(expected);
    });

    it('normalizes deck tags', () => {
      const result = canonicalizeSnapshot(
        raw({
          deck: { name: 'D', format: 'f', description: '', tags: ['b', ' a ', 'a', 'B', '', 'two  words'] },
        }),
      );
      expect(result.deck.tags).toEqual(['B', 'a', 'b', 'two words']);
    });

    it('normalizes card tags: keys via cardKey, lists merged, empty lists dropped', () => {
      const result = canonicalizeSnapshot(
        raw({
          cardTags: {
            'Dress Down': ['stax', 'hate'],
            'dress  down': ['Hate', 'stax '],
            'Sol Ring': ['  '],
            'Thassa\u2019s Oracle': ['wincon'],
          },
        }),
      );
      expect(result.cardTags).toStrictEqual({
        'dress down': ['Hate', 'hate', 'stax'],
        "thassa's oracle": ['wincon'],
      });
      expect(Object.keys(result.cardTags)).toEqual(['dress down', "thassa's oracle"]);
    });

    it('keeps card keys named like Object.prototype members as own keys', () => {
      // JSON.parse creates an own `__proto__` key; an object literal would set the prototype.
      const cardTags = JSON.parse(
        '{"__proto__":["b","a"],"CONSTRUCTOR":["x"],"constructor":["y"],"toString":["t"]}',
      ) as Record<string, string[]>;
      const result = canonicalizeSnapshot(raw({ cardTags }));
      const expected = '{"__proto__":["a","b"],"constructor":["x","y"],"tostring":["t"]}';
      expect(stableStringify(result.cardTags)).toBe(expected);
      expect(Object.keys(result.cardTags)).toEqual(['__proto__', 'constructor', 'tostring']);
      expect(Object.getPrototypeOf(result.cardTags)).toBe(Object.prototype);
      expect(stableStringify(canonicalizeSnapshot(result))).toBe(stableStringify(result));
    });
  });

  describe('primer', () => {
    it.each<[string | null, string | null]>([
      ['# Title', '# Title\n'],
      ['# Title\n', '# Title\n'],
      ['a\r\nb\rc', 'a\nb\nc\n'],
      ['text   \n\n\n', 'text\n'],
      ['line with hard break  \nend\r\n', 'line with hard break  \nend\n'],
      ['  indented\n\n    code', '  indented\n\n    code\n'],
      ['', ''],
      [' \r\n\t\n', ''],
      [null, null],
      ['Se\u0301ance', 'S\u00e9ance\n'],
    ])('normalizes %j to %j', (primer, expected) => {
      expect(normalizePrimer(primer)).toBe(expected);
      expect(canonicalizeSnapshot(raw({ primer })).primer).toBe(expected);
    });

    it('strips exactly the characters /\\s/u matches at the end of the text', () => {
      const reference = (text: string): string => {
        const trimmed = normalizeText(text).replace(/\s+$/u, '');
        return trimmed.length === 0 ? '' : `${trimmed}\n`;
      };
      for (let code = 0; code <= 0xffff; code++) {
        const text = `x${String.fromCharCode(code)}`;
        expect(normalizePrimer(text)).toBe(reference(text));
      }
    });
  });

  describe('linear time on long whitespace runs (no regex backtracking)', () => {
    const RUN = 100_000;
    const middleRun = `intro${' '.repeat(RUN)}x`;

    function timed<T>(run: () => T): { value: T; ms: number } {
      const start = performance.now();
      const value = run();
      return { value, ms: performance.now() - start };
    }

    it('normalizes a primer with a long inner whitespace run quickly', () => {
      const { value, ms } = timed(() => normalizePrimer(`${middleRun}\t \n`));
      expect(value).toBe(`${middleRun}\n`);
      // A backtracking trailing-whitespace regex takes seconds here.
      expect(ms).toBeLessThan(250);
    });

    it('normalizes a description with a long inner whitespace run quickly', () => {
      const { value, ms } = timed(
        () =>
          canonicalizeSnapshot(raw({ deck: { name: 'D', format: 'f', description: middleRun, tags: [] } }))
            .deck.description,
      );
      expect(value).toBe(middleRun);
      expect(ms).toBeLessThan(250);
    });
  });

  describe('order independence', () => {
    const a = raw({
      deck: { name: 'Blue Farm', format: 'commander', description: 'Blurb', tags: ['cEDH', 'Turbo'] },
      zones: {
        commanders: [card('Tymna the Weaver', 1, [printing('c16', '48', 1, { finish: 'foil' })])],
        mainboard: [
          card('Island', 2, [printing('ltr', '715'), printing('ltr', '716')]),
          card("Thassa's Oracle", 1, [printing('thb', '73')], { moxfield: 'thassa' }),
        ],
        sideboard: [card('Orcish Bowmasters', 1, [printing('ltr', '103')])],
      },
      cardTags: { "Thassa's Oracle": ['wincon', 'combo'] },
      primer: '# Blue Farm\n',
    });

    const b = raw({
      primer: '# Blue Farm\r\n\r\n',
      cardTags: { "thassa's oracle": ['combo', 'wincon', 'combo'] },
      zones: {
        sideboard: [card('Orcish Bowmasters', 1, [printing('LTR', '103')])],
        mainboard: [
          card('Thassa\u2019s  Oracle', 1, [printing('THB', '73')], { moxfield: 'thassa' }),
          card('Island', 1, [printing('ltr', '716')]),
          card('Island', 1, [printing('ltr', '715')]),
        ],
        commanders: [card('Tymna the Weaver', 1, [printing('c16', '48', 1, { finish: 'FOIL' })])],
      },
      deck: {
        tags: ['Turbo', 'cEDH', 'Turbo'],
        description: 'Blurb\n',
        format: 'Commander',
        name: 'Blue Farm',
      },
    });

    it('serializes semantically identical snapshots identically', () => {
      expect(stableStringify(canonicalizeSnapshot(b))).toBe(stableStringify(canonicalizeSnapshot(a)));
      expect(canonicalizeSnapshot(b)).toStrictEqual(canonicalizeSnapshot(a));
    });

    it('is invariant under shuffling of card entries (property-based)', () => {
      const names = [
        ["Thassa's Oracle", 'Thassa\u2019s Oracle', " Thassa's  Oracle"],
        ['Lim-D\u00fbl the Necromancer', 'Lim-Du\u0302l the Necromancer'],
        ['Life // Death', 'Life//Death'],
        ['Island'],
      ] as const;
      const zones: ZoneId[] = ['mainboard', 'sideboard', 'considering', 'other:extra'];
      const entryArb = fc
        .record({
          zone: fc.constantFrom(...zones),
          card: fc.nat({ max: names.length - 1 }),
          variant: fc.nat(),
          printings: fc.array(
            fc.record({
              set: fc.constantFrom('ltr', 'LTR', 'dmu'),
              collectorNumber: fc.constantFrom('1', '2', '10', '10a', '010', 'OTC-1', '12\nx'),
              finish: fc.constantFrom('nonfoil', 'foil'),
              flags: fc.constantFrom([], ['proxy'], ['Proxy', 'alter']),
              quantity: fc.integer({ min: 1, max: 3 }),
            }),
            { minLength: 1, maxLength: 3 },
          ),
        })
        .map(({ zone, card: index, variant, printings }) => {
          const spellings = names[index] ?? names[0];
          const name = spellings[variant % spellings.length] ?? spellings[0];
          // Cards of the "Life // Death" family have no printing information.
          const withPrintings = index !== 2;
          const entry: CanonicalCard = {
            key: '',
            name,
            quantity: withPrintings ? printings.reduce((n, p) => n + p.quantity, 0) : printings.length,
            printings: withPrintings
              ? printings.map((p) => ({
                  ...p,
                  flags: [...p.flags],
                  lang: 'en',
                  ids: { scryfall: `${p.set.toLowerCase()}-${p.collectorNumber}` },
                }))
              : [],
            ids: { moxfield: `card-${index}` },
          };
          return { zone, entry };
        });

      const toSnapshot = (entries: readonly { zone: ZoneId; entry: CanonicalCard }[]): CanonicalSnapshot => {
        const zoneMap: ZoneMap = {};
        for (const { zone, entry } of entries) (zoneMap[zone] ??= []).push(entry);
        return raw({ zones: zoneMap });
      };

      fc.assert(
        fc.property(
          fc
            .array(entryArb, { maxLength: 12 })
            .chain((entries) =>
              fc.tuple(
                fc.constant(entries),
                fc.shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length }),
              ),
            ),
          ([entries, shuffled]) => {
            const canonical = canonicalizeSnapshot(toSnapshot(entries));
            expect(stableStringify(canonicalizeSnapshot(toSnapshot(shuffled)))).toBe(
              stableStringify(canonical),
            );
            expect(canonicalizeSnapshot(canonical)).toStrictEqual(canonical);
          },
        ),
      );
    });
  });

  describe('golden serialization', () => {
    // Guards against accidental changes to canonicalization or serialization: every
    // stored snapshot hash and commit id depends on these exact bytes. If this test
    // fails, the change is a schema migration, not a refactor. The expected JSON equals
    // Python's json.dumps(..., sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    // of the same data, and the hash was computed with Python's hashlib.
    const golden = canonicalizeSnapshot(
      raw({
        deck: { name: 'Golden', format: 'commander', description: 'Pinned serialization.', tags: ['cEDH'] },
        zones: {
          mainboard: [
            card(
              'Lim-D\u00fbl the Necromancer',
              1,
              [printing('all', '48', 1, { ids: { scryfall: 'sf-limdul' } })],
              { moxfield: 'mx-limdul' },
            ),
            card('Island', 2, [printing('ltr', '715', 2, { finish: 'foil', lang: 'ja', flags: ['proxy'] })]),
            card('Life // Death', 1),
          ],
          commanders: [card('Tymna the Weaver', 1, [printing('c16', '48', 1, { finish: 'foil' })])],
        },
        cardTags: { 'Life // Death': ['reanimation'] },
        primer: '# Golden\n',
      }),
    );

    it('serializes to the pinned JSON', () => {
      expect(stableStringify(golden)).toBe(
        [
          '{"cardTags":{"life // death":["reanimation"]},',
          '"deck":{"description":"Pinned serialization.","format":"commander","name":"Golden","tags":["cEDH"]},',
          '"primer":"# Golden\\n",',
          '"schemaVersion":1,',
          '"zones":{',
          '"commanders":[{"ids":{},"key":"tymna the weaver","name":"Tymna the Weaver","printings":[',
          '{"collectorNumber":"48","finish":"foil","ids":{},"lang":"en","quantity":1,"set":"c16"}],"quantity":1}],',
          '"mainboard":[',
          '{"ids":{},"key":"island","name":"Island","printings":[',
          '{"collectorNumber":"715","finish":"foil","flags":["proxy"],"ids":{},"lang":"ja","quantity":2,"set":"ltr"}],',
          '"quantity":2},',
          '{"ids":{},"key":"life // death","name":"Life // Death","printings":[],"quantity":1},',
          '{"ids":{"moxfield":"mx-limdul"},"key":"lim-d\u00fbl the necromancer","name":"Lim-D\u00fbl the Necromancer",',
          '"printings":[{"collectorNumber":"48","finish":"nonfoil","ids":{"scryfall":"sf-limdul"},"lang":"en",',
          '"quantity":1,"set":"all"}],"quantity":1}]}}',
        ].join(''),
      );
    });

    it('hashes to the pinned sha256', () => {
      expect(snapshotHash(golden)).toBe('633aa1fb1e2b3a586ce657a8edafe66fee353a6ad8a61c805b087e6e93ff318a');
    });
  });
});

describe('emptySnapshot', () => {
  it('is the canonical empty deck', () => {
    expect(emptySnapshot()).toStrictEqual({
      schemaVersion: 1,
      deck: { name: '', format: '', description: '', tags: [] },
      zones: {},
      cardTags: {},
      primer: '',
    });
    expect(canonicalizeSnapshot(emptySnapshot())).toStrictEqual(emptySnapshot());
  });

  it('accepts partial deck info and normalizes tags', () => {
    expect(emptySnapshot({ name: 'New deck', tags: ['b', 'a', 'a '] }).deck).toStrictEqual({
      name: 'New deck',
      format: '',
      description: '',
      tags: ['a', 'b'],
    });
  });
});

describe('text helpers', () => {
  it('normalizeText converts line endings and composes Unicode, keeping other whitespace', () => {
    expect(normalizeText('a\r\nb\rc\n  d  ')).toBe('a\nb\nc\n  d  ');
    expect(normalizeText('u\u0302')).toBe('\u00fb');
  });

  it('normalizeTagList trims, collapses whitespace, dedupes and sorts ordinally', () => {
    expect(normalizeTagList([' b ', 'a', 'A', 'b', '', '  ', 'x  y', 'Se\u0301ance', 'S\u00e9ance'])).toEqual(
      ['A', 'S\u00e9ance', 'a', 'b', 'x y'],
    );
  });

  it('compareStrings compares UTF-16 code units, independent of locale', () => {
    expect(['b', 'a', 'B', '\u00e9', 'e', '10', '9'].sort(compareStrings)).toEqual([
      '10',
      '9',
      'B',
      'a',
      'b',
      'e',
      '\u00e9',
    ]);
    expect(compareStrings('a', 'a')).toBe(0);
  });

  it('printingIdentity ignores quantity and source ids', () => {
    const a = printing('ltr', '715', 1, { ids: { scryfall: 'a' }, flags: ['proxy'] });
    const b = printing('ltr', '715', 3, { ids: { scryfall: 'b' }, flags: ['proxy'] });
    expect(printingIdentity(a)).toBe(printingIdentity(b));
    expect(printingIdentity(a)).not.toBe(printingIdentity({ ...a, flags: [] }));
    expect(printingIdentity(a)).not.toBe(printingIdentity({ ...a, finish: 'foil' }));
    expect(printingIdentity(a)).not.toBe(printingIdentity({ ...a, lang: 'ja' }));
    expect(printingIdentity({ ...a, flags: undefined })).toBe(printingIdentity({ ...a, flags: [] }));
  });
});

describe('card names', () => {
  // The same card in two zones under different spellings: the first zone in canonical order names it.
  const snapshot = canonicalizeSnapshot(
    raw({
      zones: {
        sideboard: [card('sol ring', 1), card('Arcane Signet', 1)],
        mainboard: [card('Sol Ring', 1)],
      },
    }),
  );

  it('names a card by the first zone in canonical order that has it', () => {
    expect(cardName(snapshot, 'sol ring')).toBe('Sol Ring');
    expect(cardName(snapshot, 'arcane signet')).toBe('Arcane Signet');
    expect(cardName(snapshot, 'mana vault')).toBeUndefined();
  });

  it('lists the zones that hold a card, with their quantities, in zone order', () => {
    const twoZones = canonicalizeSnapshot(
      raw({
        zones: {
          sideboard: [card('Sol Ring', 2)],
          mainboard: [card('Sol Ring', 1), card('Arcane Signet', 1)],
        },
      }),
    );
    expect(cardZones(twoZones, 'sol ring')).toEqual([
      { zone: 'mainboard', quantity: 1 },
      { zone: 'sideboard', quantity: 2 },
    ]);
    expect(cardZones(twoZones, 'arcane signet')).toEqual([{ zone: 'mainboard', quantity: 1 }]);
    expect(cardZones(twoZones, 'mana vault')).toEqual([]);
    // The same answer as the per-card entry of the index of every card.
    expect(
      [...(cardZoneIndex(twoZones).get('sol ring') ?? [])].map(([zone, quantity]) => ({ zone, quantity })),
    ).toEqual(cardZones(twoZones, 'sol ring'));
  });

  it('lists every card once, in zone order, and sorted by key in allCards', () => {
    expect([...cardNames(snapshot)]).toEqual([
      ['sol ring', 'Sol Ring'],
      ['arcane signet', 'Arcane Signet'],
    ]);
    expect(allCards(snapshot)).toEqual([
      { key: 'arcane signet', name: 'Arcane Signet' },
      { key: 'sol ring', name: 'Sol Ring' },
    ]);
  });
});

describe('stableStringify', () => {
  it('sorts object keys recursively and keeps array order', () => {
    expect(stableStringify({ b: 1, a: 2, c: { z: 1, y: [3, { k: 2, j: 1 }, [2, 1]] } })).toBe(
      '{"a":2,"b":1,"c":{"y":[3,{"j":1,"k":2},[2,1]],"z":1}}',
    );
  });

  it('orders keys by UTF-16 code units, including integer-like keys', () => {
    const value = { a: 1, B: 2, '\u00e9': 3, '\uff01': 4, '\u{1f600}': 5, '10': 6, '9': 7 };
    // U+1F600 is the surrogate pair D83D DE00, which sorts before U+FF01 by code unit.
    expect(stableStringify(value)).toBe('{"10":6,"9":7,"B":2,"a":1,"\u00e9":3,"\u{1f600}":5,"\uff01":4}');
  });

  it('omits undefined properties and maps undefined array elements and holes to null', () => {
    expect(stableStringify({ a: undefined, b: null, c: [undefined, 1] })).toBe('{"b":null,"c":[null,1]}');
    // Regression: holes used to produce invalid JSON (`[,1]`).
    expect(stableStringify([, 1])).toBe('[null,1]');
    expect(stableStringify(new Array<unknown>(2))).toBe('[null,null]');
  });

  it('serializes primitives like JSON.stringify', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(true)).toBe('true');
    expect(stableStringify(false)).toBe('false');
    expect(stableStringify(0)).toBe('0');
    expect(stableStringify(-0)).toBe('0');
    expect(stableStringify(-1.5)).toBe('-1.5');
    expect(stableStringify(1e21)).toBe('1e+21');
    expect(stableStringify(5e-7)).toBe('5e-7');
    expect(stableStringify('')).toBe('""');
    expect(stableStringify({})).toBe('{}');
    expect(stableStringify([])).toBe('[]');
  });

  it('keeps non-ASCII text raw and escapes what JSON requires', () => {
    expect(stableStringify('Lim-D\u00fbl \u{1f600}')).toBe('"Lim-D\u00fbl \u{1f600}"');
    expect(stableStringify('quote " backslash \\ newline \n tab \t')).toBe(
      '"quote \\" backslash \\\\ newline \\n tab \\t"',
    );
    const backslash = '\\';
    expect(stableStringify('\0')).toBe(`"${backslash}u0000"`);
    expect(stableStringify('\ud800')).toBe(`"${backslash}ud800"`); // lone surrogate
  });

  it('accepts null-prototype objects', () => {
    const value = Object.create(null) as Record<string, unknown>;
    value.b = 1;
    value.a = 2;
    expect(stableStringify(value)).toBe('{"a":2,"b":1}');
  });

  it.each<[string, unknown]>([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a nested NaN', { a: [1, Number.NaN] }],
    ['a function', () => 1],
    ['a function property', { f: () => 1 }],
    ['a function array element', [() => 1]],
    ['a symbol', Symbol('s')],
    ['a symbol property', { s: Symbol('s') }],
    ['a bigint', 1n],
    ['a nested bigint', { n: 1n }],
    ['top-level undefined', undefined],
    ['a Date', new Date(0)],
    ['a nested Date', { at: new Date(0) }],
    ['a Map', new Map([['a', 1]])],
    ['a Set', new Set([1])],
    ['a typed array', new Uint8Array([1])],
    ['a boxed string', Object('s')],
    [
      'a class instance',
      new (class Point {
        x = 1;
      })(),
    ],
  ])('throws a TypeError for %s', (_, value) => {
    expect(() => stableStringify(value)).toThrow(TypeError);
  });

  it('round-trips arbitrary JSON values like JSON.stringify (property-based)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const text = stableStringify(value);
        expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(value)));
        expect(stableStringify(JSON.parse(text))).toBe(text);
      }),
    );
  });

  it('does not depend on key insertion order (property-based)', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue({ maxDepth: 2 })), (dict) => {
        const reversed = Object.fromEntries(Object.entries(dict).reverse());
        expect(stableStringify(reversed)).toBe(stableStringify(dict));
      }),
    );
  });
});
