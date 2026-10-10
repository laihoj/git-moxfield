import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { CardFacts } from '@/core/model';
import { createRepositories } from '@/server/repositories';
import { countRows, createTestRepositories, expectRepositoryError } from '@tests/support/db';

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
  it('stores and loads card facts', async () => {
    const { repos } = await createTestRepositories();
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

    await repos.catalog.upsertMany([solRing, birgi]);
    const loaded = await repos.catalog.getMany([solRing.key, birgi.key, 'unknown card']);

    expect(loaded).toEqual(
      new Map([
        [solRing.key, solRing],
        [birgi.key, birgi],
      ]),
    );
    // Optional fields stay absent rather than becoming null.
    expect(loaded.get(birgi.key)).not.toHaveProperty('scryfallId');
  });

  it('lets the latest facts win, across calls and within one call', async () => {
    const { db, repos } = await createTestRepositories();
    await repos.catalog.upsertMany([facts({ key: 'sol ring', name: 'Sol Ring', scryfallId: 'old' })]);

    await repos.catalog.upsertMany([
      facts({ key: 'sol ring', name: 'Sol Ring', manaCost: '{2}', cmc: 2.5 }),
      facts({ key: 'mana crypt', name: 'Mana Crypt' }),
      facts({ key: 'sol ring', name: 'Sol Ring', manaCost: '{1}', colorIdentity: ['C'] }),
    ]);

    expect((await repos.catalog.getMany(['sol ring'])).get('sol ring')).toEqual(
      facts({ key: 'sol ring', name: 'Sol Ring', manaCost: '{1}', colorIdentity: ['C'] }),
    );
    expect(await countRows(db, 'card_catalog')).toBe(2);
    const row = (await db.all(sql`SELECT updated_at FROM card_catalog WHERE key = 'sol ring'`))[0];
    expect(row).toEqual({ updated_at: '2026-01-01T00:00:01.000Z' });
  });

  it('keeps each workspace’s facts apart: one workspace’s write never changes another’s read', async () => {
    const { db, repos } = await createTestRepositories();
    const bob = await repos.users.create({ displayName: 'Bob', role: 'member' });
    const eve = await repos.users.create({ displayName: 'Eve', role: 'member' });
    const bobs = createRepositories(db, { workspaceId: bob.workspaceId });
    const eves = createRepositories(db, { workspaceId: eve.workspaceId });
    const genuine = facts({ key: 'sol ring', name: 'Sol Ring', scryfallId: 'genuine' });
    const crafted = facts({
      key: 'sol ring',
      name: 'Sol Ring',
      typeLine: 'Basic Land — Swamp',
      primaryType: 'Land',
      manaCost: '{B}{B}{B}{B}{B}{B}{B}',
      cmc: 7,
      colorIdentity: ['B'],
      scryfallId: 'crafted',
    });

    await bobs.catalog.upsertMany([genuine]);
    await eves.catalog.upsertMany([crafted, facts({ key: 'mana crypt', name: 'Mana Crypt' })]);

    expect(await bobs.catalog.getMany(['sol ring', 'mana crypt'])).toEqual(new Map([['sol ring', genuine]]));
    expect((await eves.catalog.getMany(['sol ring'])).get('sol ring')).toEqual(crafted);
    expect((await repos.catalog.getMany(['sol ring'])).size).toBe(0);
    expect(await countRows(db, 'card_catalog')).toBe(3);
  });

  it('handles empty input and large batches', async () => {
    const { db, repos } = await createTestRepositories();
    await repos.catalog.upsertMany([]);
    expect((await repos.catalog.getMany([])).size).toBe(0);

    const many = Array.from({ length: 1_234 }, (_, i) =>
      facts({ key: `card ${i}`, name: `Card ${i}`, cmc: i }),
    );
    await repos.catalog.upsertMany(many);

    expect(await countRows(db, 'card_catalog')).toBe(1_234);
    const loaded = await repos.catalog.getMany(many.map((f) => f.key));
    expect(loaded.size).toBe(1_234);
    expect(loaded.get('card 1233')).toEqual(many[1_233]);
  });

  it('reports a damaged color identity column as corrupt data', async () => {
    const { db, repos } = await createTestRepositories();
    await repos.catalog.upsertMany([facts({ key: 'sol ring', name: 'Sol Ring' })]);
    await db.run(sql`UPDATE card_catalog SET color_identity_json = '{"W":true}'`);
    const error = await expectRepositoryError(repos.catalog.getMany(['sol ring']), 'corrupt-data');
    expect(error.message).toMatch(/expected a string array/);
  });
});
