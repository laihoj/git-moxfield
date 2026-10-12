import { describe, expect, it } from 'vitest';

import { canonicalizeSnapshot, snapshotZones, stableStringify, zoneCards } from '@/core/canonical';
import type { CanonicalSnapshot, IngestWarning } from '@/core/model';

import { normalizeMoxfieldPayload, primaryCardType } from './normalize';
import type { MoxfieldPayloadData } from './schema';
import {
  expectDeckSourceSchemaError,
  moxfieldBoard,
  moxfieldEntry,
  syntheticDeck,
  v1Primer,
  v2Deck,
  v3Deck,
  type JsonObject,
} from './test-fixtures';

function normalize(data: Partial<MoxfieldPayloadData> & { deck: unknown }) {
  return normalizeMoxfieldPayload({ primer: v1Primer(), ...data });
}

function codes(warnings: readonly IngestWarning[]): string[] {
  return warnings.map((w) => w.code);
}

function zoneSummary(snapshot: CanonicalSnapshot): Record<string, string[]> {
  return Object.fromEntries(
    snapshotZones(snapshot).map((zone) => [
      zone,
      zoneCards(snapshot, zone).map((c) => `${c.quantity} ${c.name}`),
    ]),
  );
}

describe('normalizeMoxfieldPayload — v3 fixture', () => {
  const result = normalize({ deck: v3Deck() });

  it('maps boards to zones (maybeboard → considering, partners stay commanders)', () => {
    expect(zoneSummary(result.snapshot)).toEqual({
      commanders: ["1 Kraum, Ludevic's Opus", '1 Tymna the Weaver'],
      mainboard: [
        '1 Birgi, God of Storytelling // Harnfel, Horn of Bounty',
        '1 Command Tower',
        "1 Thassa's Oracle",
        '1 Underworld Breach',
      ],
      considering: ['1 Island', '1 Peer into the Abyss'],
    });
  });

  it('keeps printings with finishes and source ids', () => {
    const [kraum, tymna] = result.snapshot.zones.commanders ?? [];
    expect(kraum).toEqual({
      key: "kraum, ludevic's opus",
      name: "Kraum, Ludevic's Opus",
      quantity: 1,
      printings: [
        {
          set: 'c16',
          collectorNumber: '34',
          finish: 'foil',
          lang: 'en',
          quantity: 1,
          ids: { moxfield: 'Er5zR', scryfall: '557fcd17-6cb3-414a-b2b1-ea9ae32e5aec' },
        },
      ],
      ids: { moxfield: 'E12Qm' },
    });
    expect(tymna?.printings[0]).toMatchObject({ set: 'c16', collectorNumber: '48', finish: 'foil' });
    const oracle = result.snapshot.zones.mainboard?.find((c) => c.name === "Thassa's Oracle");
    expect(oracle?.printings).toEqual([
      {
        set: 'thb',
        collectorNumber: '308',
        finish: 'foil',
        lang: 'en',
        quantity: 1,
        ids: { moxfield: 'EZXJB', scryfall: '13d7e352-4d01-4947-a76f-f8a01dd876cc' },
      },
    ]);
    const breach = result.snapshot.zones.mainboard?.find((c) => c.name === 'Underworld Breach');
    expect(breach?.printings[0]?.finish).toBe('nonfoil');
  });

  it('keeps the full DFC name as display name and key', () => {
    const birgi = result.snapshot.zones.mainboard?.[0];
    expect(birgi?.key).toBe('birgi, god of storytelling // harnfel, horn of bounty');
    expect(birgi?.name).toBe('Birgi, God of Storytelling // Harnfel, Horn of Bounty');
  });

  it('fills deck info, tags and primer', () => {
    expect(result.snapshot.deck).toEqual({
      name: 'Fixture Blue Farm',
      format: 'commander',
      description: 'Fixture deck description.',
      tags: ['Primer', 'cEDH'],
    });
    expect(result.snapshot.cardTags).toEqual({});
    expect(result.snapshot.primer).toBe(`${v1Primer().content.trimEnd()}\n`);
  });

  it('produces a canonical snapshot', () => {
    expect(stableStringify(canonicalizeSnapshot(result.snapshot))).toBe(stableStringify(result.snapshot));
  });

  it('reports source metadata', () => {
    expect(result.metadata).toEqual({
      source: 'moxfield',
      externalId: 'FixtureDeckId_00000001',
      internalId: 'Fx001',
      url: 'https://moxfield.com/decks/FixtureDeckId_00000001',
      name: 'Fixture Blue Farm',
      format: 'commander',
      visibility: 'public',
      version: 2,
      lastUpdatedAt: '2026-10-06T21:32:15.327Z',
      createdAt: '2021-04-13T10:51:17.293Z',
      primerLastUpdatedAt: '2026-09-27T16:52:21.070Z',
      authors: ['fixture-user'],
      reportedCounts: { commanders: 2, mainboard: 4, considering: 2 },
    });
  });

  it('builds the card catalog from the front face of DFCs', () => {
    expect(result.catalog.map((f) => f.key)).toEqual([
      'birgi, god of storytelling // harnfel, horn of bounty',
      'command tower',
      'island',
      "kraum, ludevic's opus",
      'peer into the abyss',
      "thassa's oracle",
      'tymna the weaver',
      'underworld breach',
    ]);
    expect(result.catalog[0]).toEqual({
      key: 'birgi, god of storytelling // harnfel, horn of bounty',
      name: 'Birgi, God of Storytelling // Harnfel, Horn of Bounty',
      typeLine: 'Legendary Creature — God',
      primaryType: 'Creature',
      manaCost: '{2}{R}',
      cmc: 3,
      colorIdentity: ['R'],
      layout: 'modal_dfc',
      scryfallId: '54dccbc0-528c-4e99-a6db-f2373978fe5f',
    });
    const byKey = new Map(result.catalog.map((f) => [f.key, f]));
    expect(byKey.get('command tower')).toMatchObject({
      primaryType: 'Land',
      colorIdentity: [],
      manaCost: '',
    });
    expect(byKey.get('tymna the weaver')?.colorIdentity).toEqual(['W', 'B']);
    expect(byKey.get("kraum, ludevic's opus")?.colorIdentity).toEqual(['U', 'R']);
    expect(byKey.get('underworld breach')?.primaryType).toBe('Enchantment');
    expect(byKey.get('peer into the abyss')).toMatchObject({ primaryType: 'Sorcery', cmc: 7 });
  });

  it('has no warnings', () => {
    expect(result.warnings).toEqual([]);
  });

  it('is deterministic regardless of JSON key order', () => {
    const deck = v3Deck();
    const reversed = {
      ...deck,
      boards: Object.fromEntries(
        Object.entries(deck.boards)
          .reverse()
          .map(([name, board]) => [
            name,
            { ...board, cards: Object.fromEntries(Object.entries(board.cards).reverse()) },
          ]),
      ),
    };
    expect(normalize({ deck: reversed })).toEqual(result);
  });

  it('uses the configured site origin for the deck URL', () => {
    const custom = normalizeMoxfieldPayload(
      { deck: v3Deck(), primer: null },
      { siteOrigin: 'http://localhost:4010' },
    );
    expect(custom.metadata.url).toBe('http://localhost:4010/decks/FixtureDeckId_00000001');
  });
});

describe('normalizeMoxfieldPayload — legacy v2 shape', () => {
  const result = normalize({ deck: v2Deck(), primer: { content: '' } });

  it('reads top-level board maps', () => {
    expect(zoneSummary(result.snapshot)).toEqual({
      commanders: ['1 Tymna the Weaver'],
      mainboard: ['2 Island', "1 Thassa's Oracle"],
      considering: ['1 Peer into the Abyss'],
    });
    expect(result.warnings).toEqual([]);
  });

  it('keeps etched finish, language and proxy flag', () => {
    const oracle = result.snapshot.zones.mainboard?.[1];
    expect(oracle?.printings).toEqual([
      {
        set: 'thb',
        collectorNumber: '308',
        finish: 'etched',
        lang: 'ja',
        quantity: 1,
        flags: ['proxy'],
        ids: { moxfield: 'EZXJB', scryfall: '00000000-0000-4000-8000-000000000003' },
      },
    ]);
  });

  it('maps author tags, hubs, empty primer, null description and metadata', () => {
    expect(result.snapshot.cardTags).toEqual({ "thassa's oracle": ['Combo', 'Win Con'] });
    expect(result.snapshot.deck).toEqual({
      name: 'Fixture Legacy Deck',
      format: 'commander',
      description: '',
      tags: ['Budget'],
    });
    expect(result.snapshot.primer).toBe('');
    expect(result.metadata).toMatchObject({
      externalId: 'FixtureDeckId_00000002',
      version: 7,
      visibility: 'unlisted',
      authors: ['fixture-user', 'fixture-coauthor'],
      createdAt: '2020-01-01T00:00:00.000Z',
      lastUpdatedAt: '2020-02-01T12:00:00.000Z',
      reportedCounts: { commanders: 1, mainboard: 3, considering: 1 },
    });
    expect(result.metadata).not.toHaveProperty('primerLastUpdatedAt');
  });
});

describe('normalizeMoxfieldPayload — synthetic variants', () => {
  it('keeps unknown non-empty boards as other: zones with a warning, ignores empty ones', () => {
    const deck = syntheticDeck({
      dungeonDeck: moxfieldBoard({ a: moxfieldEntry({ name: 'Tomb of Annihilation', typeLine: 'Dungeon' }) }),
      emptyNewBoard: moxfieldBoard({}),
    });
    const { snapshot, warnings, metadata, catalog } = normalize({ deck });
    expect(zoneSummary(snapshot)).toEqual({ 'other:dungeon-deck': ['1 Tomb of Annihilation'] });
    expect(warnings).toEqual([
      {
        code: 'unknown-zone',
        message:
          'Moxfield board "dungeonDeck" is not known to git-moxfield; its cards are kept in "other:dungeon-deck".',
        details: { board: 'dungeonDeck', zone: 'other:dungeon-deck' },
      },
    ]);
    expect(metadata.reportedCounts).toEqual({ 'other:dungeon-deck': 1 });
    expect(catalog[0]?.primaryType).toBe('Dungeon');
  });

  it('skips entries with invalid quantities', () => {
    const deck = syntheticDeck({
      mainboard: moxfieldBoard(
        {
          a: moxfieldEntry({ name: 'Zero', quantity: 0 }),
          b: moxfieldEntry({ name: 'Negative', quantity: -2 }),
          c: moxfieldEntry({ name: 'Fraction', quantity: 1.5 }),
          d: moxfieldEntry({ name: 'Text', quantity: '2' }),
          e: moxfieldEntry({ name: 'Missing', quantity: undefined }),
          f: moxfieldEntry({ name: 'Fine', quantity: 2 }),
        },
        2,
      ),
    });
    const { snapshot, warnings } = normalize({ deck });
    expect(zoneSummary(snapshot)).toEqual({ mainboard: ['2 Fine'] });
    expect(warnings.map((w) => [w.code, w.details?.card, w.details?.quantity])).toEqual([
      ['invalid-quantity', 'Zero', '0'],
      ['invalid-quantity', 'Negative', '-2'],
      ['invalid-quantity', 'Fraction', '1.5'],
      ['invalid-quantity', 'Text', '"2"'],
      ['invalid-quantity', 'Missing', 'missing'],
    ]);
  });

  it('skips entries without a card or card name, and unreadable entries', () => {
    const noName = moxfieldEntry({ name: 'x' });
    (noName.card as JsonObject).name = '';
    const deck = syntheticDeck({
      mainboard: {
        count: 1,
        cards: { a: noName, b: { quantity: 1 }, c: 'garbage', d: moxfieldEntry({ name: 'Fine' }) },
      },
    });
    const { snapshot, warnings } = normalize({ deck });
    expect(zoneSummary(snapshot)).toEqual({ mainboard: ['1 Fine'] });
    expect(codes(warnings)).toEqual(['missing-field', 'missing-field', 'unexpected-shape']);
    expect(warnings[0]?.details).toMatchObject({ board: 'mainboard', entry: 'a' });
    expect(warnings[0]?.details?.issues).toContain('boards.mainboard.cards.a.card.name');
    expect(warnings[1]?.details?.issues).toContain(
      'boards.mainboard.cards.b.card: Invalid input: expected object',
    );
  });

  it('warns when the reported board count disagrees with the entries', () => {
    const deck = syntheticDeck({
      sideboard: moxfieldBoard({ a: moxfieldEntry({ name: 'One', quantity: 3 }) }, 5),
    });
    const { warnings, metadata } = normalize({ deck });
    expect(warnings).toEqual([
      {
        code: 'count-mismatch',
        message: 'Moxfield reports 5 cards in "sideboard", but 3 were read.',
        details: { board: 'sideboard', zone: 'sideboard', reported: 5, counted: 3 },
      },
    ]);
    expect(metadata.reportedCounts).toEqual({ sideboard: 5 });
  });

  it('merges true duplicate entries with a warning', () => {
    const entry = { name: 'Sol Ring', set: 'cmm', cn: '703', uniqueCardId: 'sol', id: 'p1' };
    const deck = syntheticDeck({
      mainboard: moxfieldBoard({
        a: moxfieldEntry({ ...entry, quantity: 1 }),
        b: moxfieldEntry({ ...entry, quantity: 2, id: 'p2', scryfallId: 's2' }),
      }),
    });
    const { snapshot, warnings } = normalize({ deck });
    expect(snapshot.zones.mainboard).toEqual([
      {
        key: 'sol ring',
        name: 'Sol Ring',
        quantity: 3,
        printings: [
          {
            set: 'cmm',
            collectorNumber: '703',
            finish: 'nonfoil',
            lang: 'en',
            quantity: 3,
            ids: { moxfield: 'p1', scryfall: 's-Sol Ring' },
          },
        ],
        ids: { moxfield: 'sol' },
      },
    ]);
    expect(warnings).toEqual([
      {
        code: 'merged-duplicate-entries',
        message: 'Sol Ring appears in several identical entries in Mainboard; they were merged.',
        details: { zone: 'mainboard', card: 'Sol Ring', entries: 2 },
      },
    ]);
  });

  it('keeps multiple printings of one card in a board without warnings', () => {
    const deck = syntheticDeck(
      {
        mainboard: moxfieldBoard({
          a: moxfieldEntry({ name: 'Island', set: 'unf', cn: '235★', finish: 'foil', quantity: 1 }),
          b: moxfieldEntry({ name: 'Island', set: 'ZNR', cn: '271', quantity: 3 }),
          c: moxfieldEntry({ name: 'Island', set: 'unf', cn: '235★', finish: 'nonFoil', isAlter: true }),
        }),
      },
      { enableMultiplePrintings: true },
    );
    const { snapshot, warnings } = normalize({ deck });
    expect(warnings).toEqual([]);
    const island = snapshot.zones.mainboard?.[0];
    expect(island?.quantity).toBe(5);
    expect(island?.printings.map((p) => [p.set, p.collectorNumber, p.finish, p.quantity, p.flags])).toEqual([
      ['unf', '235★', 'foil', 1, undefined],
      ['unf', '235★', 'nonfoil', 1, ['alter']],
      ['znr', '271', 'nonfoil', 3, undefined],
    ]);
  });

  it('drops printings of a card when some of its entries lack them', () => {
    const noSet = moxfieldEntry({ name: 'Island' });
    delete (noSet.card as JsonObject).set;
    const deck = syntheticDeck({
      mainboard: moxfieldBoard({ a: noSet, b: moxfieldEntry({ name: 'Island', set: 'znr', cn: '271' }) }),
    });
    const { snapshot, warnings } = normalize({ deck });
    expect(snapshot.zones.mainboard).toEqual([
      { key: 'island', name: 'Island', quantity: 2, printings: [], ids: { moxfield: 'u-Island' } },
    ]);
    expect(codes(warnings)).toEqual(['missing-field', 'missing-field']);
    expect(warnings[0]?.details).toMatchObject({ field: 'card.set' });
  });

  it('maps author tags to card keys, keeping tags of cards outside the deck', () => {
    const deck = syntheticDeck(
      { mainboard: moxfieldBoard({ a: moxfieldEntry({ name: 'Dress Down' }) }) },
      {
        authorTags: {
          'Dress Down': ['stax', ' hate ', 'stax', 7],
          'DRESS DOWN': ['extra'],
          'Old Card': ['cut'],
          'No Tags': [],
          Broken: 'nope',
        },
      },
    );
    expect(normalize({ deck }).snapshot.cardTags).toEqual({
      'dress down': ['extra', 'hate', 'stax'],
      'old card': ['cut'],
    });
  });

  it('keeps author tags of cards named like Object.prototype members', () => {
    // Parsed from JSON text, as captures are, so `__proto__` is an own key.
    const authorTags = JSON.parse(
      '{"Constructor":["x"],"__proto__":["combo"],"Sol Ring":["ramp"]}',
    ) as JsonObject;
    const deck = syntheticDeck(
      { mainboard: moxfieldBoard({ a: moxfieldEntry({ name: 'Sol Ring' }) }) },
      { authorTags },
    );
    const { snapshot } = normalize({ deck });
    expect(Object.keys(snapshot.cardTags)).toEqual(['__proto__', 'constructor', 'sol ring']);
    expect(stableStringify(snapshot.cardTags)).toBe(
      '{"__proto__":["combo"],"constructor":["x"],"sol ring":["ramp"]}',
    );
    expect(Object.getPrototypeOf(snapshot.cardTags)).toBe(Object.prototype);
  });

  it('normalizes a primer and description with long whitespace runs in linear time', () => {
    const run = ' '.repeat(200_000);
    const started = performance.now();
    const { snapshot } = normalize({
      deck: syntheticDeck({}, { description: `About\n${run}x  ` }),
      primer: { ...v1Primer(), content: `Intro\n===panel:x${run}y\n` },
    });
    expect(snapshot.deck.description).toBe(`About\n${run}x`);
    expect(snapshot.primer).toBe(`Intro\n===panel:x${run}y\n`);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('marks a missing primer as unavailable', () => {
    const { snapshot, warnings, metadata } = normalize({ deck: v3Deck(), primer: null });
    expect(snapshot.primer).toBeNull();
    expect(warnings).toEqual([{ code: 'primer-unavailable', message: 'The primer was not captured.' }]);
    expect(metadata).not.toHaveProperty('primerLastUpdatedAt');
  });

  it('marks a failed primer request as unavailable', () => {
    const { snapshot, warnings } = normalize({
      deck: v3Deck(),
      primer: null,
      primerError: 'timeout: too slow',
    });
    expect(snapshot.primer).toBeNull();
    expect(warnings).toEqual([
      { code: 'primer-unavailable', message: 'The primer could not be retrieved: timeout: too slow' },
    ]);
  });

  it('marks unrecognized primer data as unavailable', () => {
    const { snapshot, warnings } = normalize({ deck: v3Deck(), primer: { body: 'x' } });
    expect(snapshot.primer).toBeNull();
    expect(codes(warnings)).toEqual(['primer-unavailable']);
    expect(warnings[0]?.details?.issues).toContain('primer.content');
  });

  it('falls back to isFoil when finish is missing and keeps unknown finishes lowercased', () => {
    const foil = moxfieldEntry({ name: 'A', isFoil: true });
    delete foil.finish;
    const deck = syntheticDeck({
      mainboard: moxfieldBoard({ a: foil, b: moxfieldEntry({ name: 'B', finish: 'Galaxy' }) }),
    });
    const finishes = normalize({ deck }).snapshot.zones.mainboard?.map((c) => c.printings[0]?.finish);
    expect(finishes).toEqual(['foil', 'galaxy']);
  });

  it('tolerates wrong-typed reference data on cards', () => {
    const entry = moxfieldEntry({ name: 'Weird Card' });
    Object.assign(entry.card as JsonObject, { cmc: 'lots', color_identity: 'U', type_line: null, layout: 5 });
    const { catalog, warnings } = normalize({
      deck: syntheticDeck({ mainboard: moxfieldBoard({ a: entry }) }),
    });
    expect(warnings).toEqual([]);
    expect(catalog[0]).toMatchObject({
      typeLine: '',
      primaryType: 'Other',
      cmc: 0,
      colorIdentity: [],
      layout: 'normal',
    });
  });

  it('skips an unknown board with an unexpected shape, with a warning', () => {
    const { warnings } = normalize({ deck: syntheticDeck({ futureBoard: { cards: [] } }) });
    expect(codes(warnings)).toEqual(['unexpected-shape']);
  });

  it('ignores null boards', () => {
    const { snapshot, warnings } = normalize({
      deck: syntheticDeck({ stickers: null as unknown as JsonObject }),
    });
    expect(snapshot.zones).toEqual({});
    expect(warnings).toEqual([]);
  });
});

describe('normalizeMoxfieldPayload — fatal schema problems', () => {
  it('requires publicId and name', () => {
    const { publicId: _p, name: _n, ...deck } = v3Deck();
    expectDeckSourceSchemaError(() => normalize({ deck }), 'publicId:', 'name:');
  });

  it('requires boards in either shape', () => {
    const { boards: _b, ...deck } = v3Deck();
    expectDeckSourceSchemaError(() => normalize({ deck }), 'boards: Invalid input');
  });

  it('requires a mainboard board', () => {
    const deck = v3Deck();
    const { mainboard: _m, ...boards } = deck.boards;
    expectDeckSourceSchemaError(() => normalize({ deck: { ...deck, boards } }), 'boards.mainboard');
  });

  it('fails on a known board with an unexpected shape', () => {
    const deck = { ...v3Deck(), boards: { ...v3Deck().boards, sideboard: { count: 1, cards: [] } } };
    expectDeckSourceSchemaError(
      () => normalize({ deck }),
      'boards.sideboard.cards: Invalid input: expected object',
    );
  });

  it('fails on non-object decks', () => {
    expectDeckSourceSchemaError(() => normalize({ deck: null }), 'not usable');
    expectDeckSourceSchemaError(() => normalize({ deck: [] }), '(root)');
  });
});

describe('primaryCardType', () => {
  it.each([
    ['Creature — Merfolk Wizard', 'Creature'],
    ['Artifact Creature — Golem', 'Creature'],
    ['Land Creature — Forest Dryad', 'Creature'],
    ['Enchantment Creature — God', 'Creature'],
    ['Legendary Planeswalker — Jace', 'Planeswalker'],
    ['Battle — Siege', 'Battle'],
    ['Artifact Land', 'Land'],
    ['Basic Land — Island', 'Land'],
    ['Kindred Instant — Elf', 'Instant'],
    ['Sorcery', 'Sorcery'],
    ['Legendary Enchantment Artifact', 'Artifact'],
    ['Artifact — Equipment', 'Artifact'],
    ['Enchantment — Aura', 'Enchantment'],
    ['Legendary Creature — God // Legendary Artifact', 'Creature'],
    ['Instant // Sorcery', 'Instant'],
    ['Plane — Dominaria', 'Plane'],
    ['Ongoing Scheme', 'Scheme'],
    ['Stickers', 'Stickers'],
    ['Creature—Elf', 'Creature'],
    ['', 'Other'],
  ])('%j → %s', (typeLine, expected) => {
    expect(primaryCardType(typeLine)).toBe(expected);
  });
});
