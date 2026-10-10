import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { emptySnapshot, stableStringify } from '@/core/canonical';
import { snapshotHash } from '@/core/hash';
import type { CanonicalSnapshot } from '@/core/model';
import { MAX_STORED_VALUE_BYTES } from '@/server/repositories';
import { baseDeckSpec, buildSnapshot } from '@tests/support/builders';
import {
  countRows,
  createTestRepositories,
  expectDatabaseError,
  expectRepositoryError,
} from '@tests/support/db';

function richSnapshot(): CanonicalSnapshot {
  return buildSnapshot({
    deck: {
      name: 'Blue Farm',
      format: 'commander',
      description: 'Line one\nLine two',
      tags: ['cEDH', 'Turbo'],
    },
    zones: {
      commanders: [
        {
          name: 'Tymna the Weaver',
          ids: { moxfield: 'tymna-oracle' },
          printings: [{ set: 'c16', collectorNumber: '48', finish: 'foil', ids: { scryfall: 'tymna-c16' } }],
        },
        "Kraum, Ludevic's Opus",
      ],
      mainboard: [
        {
          name: 'Island',
          quantity: 3,
          printings: [
            { set: 'unf', collectorNumber: '536', quantity: 2 },
            { set: 'ltr', collectorNumber: '715', quantity: 1, lang: 'ja', flags: ['proxy', 'alter'] },
          ],
        },
        { name: 'Sol Ring', noPrintings: true },
        'Dress Down',
      ],
      considering: ['Dress Down', 'Lórien Revealed'],
      'other:contraptions': ['Boomflinger'],
    },
    cardTags: { 'dress down': ['hate', 'stax'] },
    primer: '# Primer\n\nWin with Thassa’s Oracle.\n',
  });
}

describe('snapshots repository', () => {
  it('round-trips a snapshot exactly and addresses it by its content hash', async () => {
    const { repos } = await createTestRepositories();
    const snapshot = richSnapshot();

    const hash = await repos.snapshots.put(snapshot);

    expect(hash).toBe(snapshotHash(snapshot));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const loaded = await repos.snapshots.get(hash);
    expect(loaded).toEqual(snapshot);
    expect(loaded && stableStringify(loaded)).toBe(stableStringify(snapshot));
  });

  it('stores the canonical JSON text whose hash is the key', async () => {
    const { db, repos } = await createTestRepositories();
    const snapshot = richSnapshot();
    const hash = await repos.snapshots.put(snapshot);
    const row = (
      await db.all(sql`SELECT schema_version, canonical_json FROM snapshots WHERE hash = ${hash}`)
    )[0];
    expect(row).toEqual({ schema_version: 1, canonical_json: stableStringify(snapshot) });
  });

  it('round-trips null and empty primers and the empty deck', async () => {
    const { repos } = await createTestRepositories();
    for (const snapshot of [
      emptySnapshot(),
      buildSnapshot({ primer: null }),
      buildSnapshot({ primer: '' }),
    ]) {
      expect(await repos.snapshots.get(await repos.snapshots.put(snapshot))).toEqual(snapshot);
    }
  });

  it('is idempotent: storing the same content twice keeps one row and one index', async () => {
    const { db, repos } = await createTestRepositories();
    const first = await repos.snapshots.put(richSnapshot());
    const cards = await countRows(db, 'snapshot_cards');
    const second = await repos.snapshots.put(richSnapshot());

    expect(second).toBe(first);
    expect(await countRows(db, 'snapshots')).toBe(1);
    expect(await countRows(db, 'snapshot_cards')).toBe(cards);
  });

  it('indexes one row per zone and card', async () => {
    const { db, repos } = await createTestRepositories();
    const hash = await repos.snapshots.put(richSnapshot());
    const rows = await db.all(
      sql`SELECT zone, card_key, name, quantity FROM snapshot_cards WHERE snapshot_hash = ${hash} ORDER BY zone, card_key`,
    );
    expect(rows).toEqual([
      { zone: 'commanders', card_key: "kraum, ludevic's opus", name: "Kraum, Ludevic's Opus", quantity: 1 },
      { zone: 'commanders', card_key: 'tymna the weaver', name: 'Tymna the Weaver', quantity: 1 },
      { zone: 'considering', card_key: 'dress down', name: 'Dress Down', quantity: 1 },
      { zone: 'considering', card_key: 'lórien revealed', name: 'Lórien Revealed', quantity: 1 },
      { zone: 'mainboard', card_key: 'dress down', name: 'Dress Down', quantity: 1 },
      { zone: 'mainboard', card_key: 'island', name: 'Island', quantity: 3 },
      { zone: 'mainboard', card_key: 'sol ring', name: 'Sol Ring', quantity: 1 },
      { zone: 'other:contraptions', card_key: 'boomflinger', name: 'Boomflinger', quantity: 1 },
    ]);
  });

  it('indexes large snapshots in batches', async () => {
    const { db, repos } = await createTestRepositories();
    const names = Array.from({ length: 1_200 }, (_, i) => `Card ${String(i).padStart(4, '0')}`);
    const snapshot = buildSnapshot({ zones: { mainboard: names, considering: names.slice(0, 300) } });
    const hash = await repos.snapshots.put(snapshot);
    expect(await countRows(db, 'snapshot_cards')).toBe(1_500);
    expect(await repos.snapshots.get(hash)).toEqual(snapshot);
  });

  it('rejects snapshots that are not canonical', async () => {
    const { db, repos } = await createTestRepositories();
    const canonical = buildSnapshot(baseDeckSpec());
    const mainboard = canonical.zones.mainboard ?? [];
    const unsorted: CanonicalSnapshot = {
      ...canonical,
      zones: { ...canonical.zones, mainboard: [...mainboard].reverse() },
    };
    const badVersion = { ...canonical, schemaVersion: 2 } as unknown as CanonicalSnapshot;
    const invalid: CanonicalSnapshot = {
      ...canonical,
      zones: { mainboard: [{ key: 'x', name: 'X', quantity: 0, printings: [], ids: {} }] },
    };

    await expectRepositoryError(() => repos.snapshots.put(unsorted), 'invalid-input');
    await expectRepositoryError(() => repos.snapshots.put(badVersion), 'invalid-input');
    await expectRepositoryError(() => repos.snapshots.put(invalid), 'invalid-input');
    expect(await countRows(db, 'snapshots')).toBe(0);
  });

  it('returns null for unknown hashes', async () => {
    const { repos } = await createTestRepositories();
    expect(await repos.snapshots.get('0'.repeat(64))).toBeNull();
  });

  it('loads many snapshots at once', async () => {
    const { repos } = await createTestRepositories();
    const a = buildSnapshot(baseDeckSpec());
    const b = richSnapshot();
    const hashA = await repos.snapshots.put(a);
    const hashB = await repos.snapshots.put(b);

    const loaded = await repos.snapshots.getMany([hashA, hashB, hashA, 'f'.repeat(64)]);

    expect([...loaded.keys()].sort()).toEqual([hashA, hashB].sort());
    expect(loaded.get(hashA)).toEqual(a);
    expect(loaded.get(hashB)).toEqual(b);
    expect((await repos.snapshots.getMany([])).size).toBe(0);
  });

  it('refuses to read snapshots written with another schema version', async () => {
    const { db, repos } = await createTestRepositories();
    const hash = 'a'.repeat(64);
    await db.run(
      sql`INSERT INTO snapshots (hash, schema_version, canonical_json, created_at) VALUES (${hash}, ${99}, ${'{"schemaVersion":99}'}, ${'2026-01-01T00:00:00.000Z'})`,
    );
    await expectRepositoryError(() => repos.snapshots.get(hash), 'unsupported-version');
  });

  it('reports unreadable canonical JSON as corrupt data', async () => {
    const { db, repos } = await createTestRepositories();
    const hash = 'b'.repeat(64);
    await db.run(
      sql`INSERT INTO snapshots (hash, schema_version, canonical_json, created_at) VALUES (${hash}, ${1}, ${'{"schemaVersion":1'}, ${'2026-01-01T00:00:00.000Z'})`,
    );
    await expectRepositoryError(() => repos.snapshots.get(hash), 'corrupt-data');
  });

  it('is immutable: snapshots and their index rows cannot be updated', async () => {
    const { db, repos } = await createTestRepositories();
    const hash = await repos.snapshots.put(richSnapshot());
    await expectDatabaseError(
      db.run(sql`UPDATE snapshots SET canonical_json = '{}' WHERE hash = ${hash}`),
      'trigger',
      /snapshots are immutable/,
    );
    await expectDatabaseError(
      db.run(sql`UPDATE snapshot_cards SET quantity = 4 WHERE snapshot_hash = ${hash}`),
      'trigger',
      /immutable/,
    );
    expect(await repos.snapshots.get(hash)).toEqual(richSnapshot());
  });

  it('refuses snapshots too large to store, before writing anything', async () => {
    const { db, repos } = await createTestRepositories();
    const huge = buildSnapshot({
      ...baseDeckSpec(),
      primer: `# Primer\n\n${'x'.repeat(MAX_STORED_VALUE_BYTES)}\n`,
    });
    const error = await expectRepositoryError(repos.snapshots.put(huge), 'invalid-input');
    expect(error.message).toMatch(/^Snapshot [0-9a-f]{64} is too large to store/);
    expect(await countRows(db, 'snapshots')).toBe(0);
    expect(await countRows(db, 'snapshot_cards')).toBe(0);
  });
});
