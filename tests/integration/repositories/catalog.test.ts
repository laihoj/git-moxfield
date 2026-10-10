import { describe, expect, it } from 'vitest';

import type { CardFacts } from '@/core/model';
import { countRows, createTestRepositories } from '@tests/support/db';

function facts(overrides: Partial<CardFacts> & Pick<CardFacts, 'key' | 'name'>): CardFacts {
  return {
    typeLine: 'Artifact',
    primaryType: 'Artifact',
    manaCost: '{1}',
    cmc: 1,
    colorIdentity: [],
    layout: 'normal',
    ...overrides,
  };
}

describe('card catalog repository', () => {
  it('stores and loads card facts', () => {
    const { repos } = createTestRepositories();
    const solRing = facts({ key: 'sol ring', name: 'Sol Ring', scryfallId: 'scryfall-sol-ring' });
    const birgi = facts({
      key: 'birgi, god of storytelling // harnfel, horn of bounty',
      name: 'Birgi, God of Storytelling // Harnfel, Horn of Bounty',
      typeLine: 'Legendary Creature — God // Legendary Artifact',
      primaryType: 'Creature',
      manaCost: '{2}{R}',
      cmc: 3,
      colorIdentity: ['R'],
      layout: 'modal_dfc',
    });

    repos.catalog.upsertMany([solRing, birgi]);
    const loaded = repos.catalog.getMany([solRing.key, birgi.key, 'unknown card']);

    expect(loaded).toEqual(
      new Map([
        [solRing.key, solRing],
        [birgi.key, birgi],
      ]),
    );
    // Optional fields stay absent rather than becoming null.
    expect(loaded.get(birgi.key)).not.toHaveProperty('scryfallId');
  });

  it('lets the latest facts win, across calls and within one call', () => {
    const { db, repos } = createTestRepositories();
    repos.catalog.upsertMany([facts({ key: 'sol ring', name: 'Sol Ring', scryfallId: 'old' })]);

    repos.catalog.upsertMany([
      facts({ key: 'sol ring', name: 'Sol Ring', manaCost: '{2}', cmc: 2.5 }),
      facts({ key: 'mana crypt', name: 'Mana Crypt' }),
      facts({ key: 'sol ring', name: 'Sol Ring', manaCost: '{1}', colorIdentity: ['C'] }),
    ]);

    expect(repos.catalog.getMany(['sol ring']).get('sol ring')).toEqual(
      facts({ key: 'sol ring', name: 'Sol Ring', manaCost: '{1}', colorIdentity: ['C'] }),
    );
    expect(countRows(db, 'card_catalog')).toBe(2);
    const row = db.$client.prepare("SELECT updated_at FROM card_catalog WHERE key = 'sol ring'").get();
    expect(row).toEqual({ updated_at: '2026-01-01T00:00:01.000Z' });
  });

  it('handles empty input and large batches', () => {
    const { db, repos } = createTestRepositories();
    repos.catalog.upsertMany([]);
    expect(repos.catalog.getMany([]).size).toBe(0);

    const many = Array.from({ length: 1_234 }, (_, i) =>
      facts({ key: `card ${i}`, name: `Card ${i}`, cmc: i }),
    );
    repos.catalog.upsertMany(many);

    expect(countRows(db, 'card_catalog')).toBe(1_234);
    const loaded = repos.catalog.getMany(many.map((f) => f.key));
    expect(loaded.size).toBe(1_234);
    expect(loaded.get('card 1233')).toEqual(many[1_233]);
  });

  it('reports a damaged color identity column as corrupt data', () => {
    const { db, repos } = createTestRepositories();
    repos.catalog.upsertMany([facts({ key: 'sol ring', name: 'Sol Ring' })]);
    db.$client.prepare(`UPDATE card_catalog SET color_identity_json = '{"W":true}'`).run();
    expect(() => repos.catalog.getMany(['sol ring'])).toThrow(/expected a string array/);
  });
});
