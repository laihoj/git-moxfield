import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { CardFacts } from '@/core/model';
import { createRepositories } from '@/server/repositories';
import { catalogLookupQuery } from '@/server/repositories/catalog';
import {
  countRows,
  createTestRepositories,
  expectRepositoryError,
  openTestDatabase,
} from '@tests/support/db';

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

  it('rewrites only the rows whose facts changed (Turso bills every row written)', async () => {
    const { db, repos } = await createTestRepositories();
    /** Rows `upsertMany(input)` inserted or updated (the in-memory database has one connection). */
    const rowsWritten = async (input: CardFacts[]): Promise<number> => {
      const total = async () => (await db.all<{ n: number }>(sql`SELECT total_changes() AS n`))[0]?.n ?? 0;
      const before = await total();
      await repos.catalog.upsertMany(input);
      return (await total()) - before;
    };
    const updatedAt = async (key: string) =>
      (await db.all<{ at: string }>(sql`SELECT updated_at AS at FROM card_catalog WHERE key = ${key}`))[0]
        ?.at;
    const solRing = facts({ key: 'sol ring', name: 'Sol Ring', scryfallId: 'scryfall-sol-ring' });
    const crypt = facts({ key: 'mana crypt', name: 'Mana Crypt' });
    const vault = facts({ key: 'mana vault', name: 'Mana Vault', cmc: 1.5, scryfallId: 'vault' });
    expect(await rowsWritten([solRing, crypt, vault])).toBe(3);
    const firstWritten = await updatedAt('sol ring');

    // The same facts again (a capture of an unchanged deck): nothing is written.
    expect(await rowsWritten([solRing, crypt, vault])).toBe(0);
    expect(await updatedAt('sol ring')).toBe(firstWritten);

    // Changes to and from NULL, and of a number; the duplicate key's last entry wins.
    const changed = [
      { ...solRing, scryfallId: undefined },
      { ...crypt, scryfallId: 'crypt' },
      { ...vault, cmc: 2 },
    ];
    expect(await rowsWritten([solRing, ...changed])).toBe(3);
    expect(await updatedAt('sol ring')).not.toBe(firstWritten);
    expect(await repos.catalog.getMany(['sol ring', 'mana crypt', 'mana vault'])).toEqual(
      new Map(changed.map((fact) => [fact.key, fact])),
    );

    // Every fact counts as a change.
    const plain = changed[0] ?? solRing;
    for (const change of [
      { name: 'Sol Ring!' },
      { typeLine: 'Legendary Artifact' },
      { primaryType: 'Creature' },
      { manaCost: '{2}' },
      { colorIdentity: ['W'] },
      { layout: 'split' },
    ] satisfies Partial<CardFacts>[]) {
      expect(await rowsWritten([{ ...plain, ...change }]), JSON.stringify(change)).toBe(1);
      expect(await rowsWritten([plain])).toBe(1);
    }
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

  it('looks facts up by primary key, one probe per card, without a temporary table of the keys', async () => {
    // `key IN (?, ?, ...)` would build a temporary table of the keys, whose rows remote
    // libSQL counts as read too: three rows read per card instead of one.
    const db = await openTestDatabase();
    const plan = await db.all<{ detail: string }>(
      sql`EXPLAIN QUERY PLAN ${catalogLookupQuery('workspace', ['sol ring', 'mana crypt', 'island'])}`,
    );
    expect(plan.map((row) => row.detail)).toEqual([
      'CO-ROUTINE wanted',
      'SCAN 3 CONSTANT ROWS',
      'SCAN wanted',
      'SEARCH c USING INDEX sqlite_autoindex_card_catalog_1 (workspace_id=? AND key=?)',
    ]);
  });
});
