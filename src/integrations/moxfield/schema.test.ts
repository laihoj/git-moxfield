import { describe, expect, it } from 'vitest';

import {
  parseMoxfieldBoard,
  parseMoxfieldCard,
  parseMoxfieldDeck,
  parseMoxfieldPayloadData,
  parseMoxfieldPrimer,
} from './schema';
import { v1Primer, v3Deck } from './test-fixtures';

describe('parseMoxfieldDeck', () => {
  it('accepts the v3 fixture and keeps only the fields normalization reads', () => {
    const result = parseMoxfieldDeck(v3Deck());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      id: 'Fx001',
      publicId: 'FixtureDeckId_00000001',
      name: 'Fixture Blue Farm',
      format: 'commander',
      version: 2,
      hubs: ['cEDH', 'Primer'],
      createdByUser: { userName: 'fixture-user' },
    });
    expect(result.value).not.toHaveProperty('viewCount');
  });

  it('ignores extra fields and degrades wrong-typed non-essential fields to undefined', () => {
    const deck = {
      ...v3Deck(),
      somethingNew: { nested: [1, 2, 3] },
      version: 'two',
      description: 42,
      visibility: ['public'],
      createdByUser: 'fixture-user',
      authors: 'nobody',
      hubs: [{ name: 'cEDH' }, 'Turbo', { label: 'odd' }, null],
      authorTags: ['not', 'a', 'map'],
      lastUpdatedAtUtc: 1234,
      enableMultiplePrintings: 'yes',
    };
    const result = parseMoxfieldDeck(deck);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      version: undefined,
      description: undefined,
      visibility: undefined,
      createdByUser: undefined,
      authors: undefined,
      hubs: ['cEDH', 'Turbo', null, null],
      authorTags: undefined,
      lastUpdatedAtUtc: undefined,
      enableMultiplePrintings: undefined,
    });
  });

  it('reports readable issue paths when essentials are missing', () => {
    const { publicId: _publicId, name: _name, ...rest } = v3Deck();
    const result = parseMoxfieldDeck(rest);
    expect(result).toEqual({
      ok: false,
      issues: [
        'publicId: Invalid input: expected string, received undefined',
        'name: Invalid input: expected string, received undefined',
      ],
    });
  });

  it('rejects malformed deck ids and non-object boards', () => {
    const result = parseMoxfieldDeck({ ...v3Deck(), publicId: '../../etc', boards: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      'publicId: Invalid input: expected a Moxfield deck id',
      'boards: Invalid input: expected object',
    ]);
  });

  it('rejects non-objects', () => {
    expect(parseMoxfieldDeck('deck')).toEqual({
      ok: false,
      issues: ['(root): Invalid input: expected object, received string'],
    });
  });
});

describe('parseMoxfieldBoard / parseMoxfieldCard', () => {
  it('prefixes issue paths', () => {
    expect(parseMoxfieldBoard({ count: 'x', cards: null }, 'boards.mainboard')).toEqual({
      ok: false,
      issues: ['boards.mainboard.cards: Invalid input: expected object'],
    });
    expect(parseMoxfieldCard({ name: '  ' }, 'boards.mainboard.cards.abc.card')).toEqual({
      ok: false,
      issues: ['boards.mainboard.cards.abc.card.name: Too small: expected string to have >=1 characters'],
    });
  });

  it('keeps cards with odd reference data', () => {
    const result = parseMoxfieldCard({
      name: 'Odd Card',
      cmc: '3',
      color_identity: ['U', 7],
      card_faces: [null, { name: 'Front', type_line: 5 }],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        name: 'Odd Card',
        cmc: undefined,
        color_identity: ['U', ''],
        card_faces: [null, { name: 'Front', mana_cost: undefined, type_line: undefined }],
        id: undefined,
        uniqueCardId: undefined,
        scryfall_id: undefined,
        set: undefined,
        cn: undefined,
        lang: undefined,
        layout: undefined,
        type_line: undefined,
        mana_cost: undefined,
      },
    });
  });
});

describe('parseMoxfieldPrimer', () => {
  it('accepts the fixture', () => {
    const result = parseMoxfieldPrimer(v1Primer());
    expect(result.ok && result.value.lastUpdatedAtUtc).toBe('2026-09-27T16:52:21.07Z');
  });

  it('treats null content as an empty primer and rejects missing content', () => {
    expect(parseMoxfieldPrimer({ content: null })).toMatchObject({ ok: true, value: { content: '' } });
    expect(parseMoxfieldPrimer({ title: 'x' })).toEqual({
      ok: false,
      issues: ['primer.content: Invalid input: expected string, received undefined'],
    });
  });
});

describe('parseMoxfieldPayloadData', () => {
  it('requires a deck and defaults the primer to null', () => {
    expect(parseMoxfieldPayloadData({ deck: { a: 1 } })).toEqual({
      ok: true,
      value: { deck: { a: 1 }, primer: null },
    });
    expect(parseMoxfieldPayloadData({ deck: {}, primer: null, primerError: 'boom' })).toEqual({
      ok: true,
      value: { deck: {}, primer: null, primerError: 'boom' },
    });
    expect(parseMoxfieldPayloadData({ primer: {} }).ok).toBe(false);
    expect(parseMoxfieldPayloadData(null).ok).toBe(false);
  });
});
