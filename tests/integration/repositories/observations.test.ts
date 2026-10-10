import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { IngestWarning } from '@/core/model';
import type { NewObservation } from '@/server/repositories';
import { baseDeckSpec, buildSnapshot } from '@tests/support/builders';
import {
  commitTestSnapshot,
  countRows,
  createTestDeck,
  createTestRepositories,
  expectRepositoryError,
  observeTestSnapshot,
  testSourceMetadata,
} from '@tests/support/db';
import { defined } from '@tests/support/services';

describe('observations repository', () => {
  it('inserts an observation and reads it back with typed JSON fields', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const snapshotHash = await repos.snapshots.put(buildSnapshot(baseDeckSpec()));
    const rawBlobHash = await repos.rawBlobs.put({ mediaType: 'application/json', data: { deck: 'raw' } });
    const warnings: IngestWarning[] = [
      {
        code: 'unknown-zone',
        message: 'Unknown board "stickers2"',
        details: { board: 'stickers2', count: 2 },
      },
      { code: 'primer-unavailable', message: 'Primer request failed' },
    ];
    const input: NewObservation = {
      deckId: deck.id,
      snapshotHash,
      rawBlobHash,
      ingestMethod: 'browser-capture',
      fetchedAt: '2026-04-01T12:00:00.000Z',
      sourceVersion: 17,
      sourceUpdatedAt: '2026-03-31T08:00:00.000Z',
      sourceMetadata: testSourceMetadata(deck, {
        internalId: 'A0j00',
        version: 17,
        visibility: 'public',
        reportedCounts: { mainboard: 9, commanders: 2 },
      }),
      warnings,
    };

    const inserted = await repos.observations.insert(input);

    expect(inserted).toEqual({ id: expect.any(String) as string, ...input });
    expect(await repos.observations.getById(inserted.id)).toEqual(inserted);
    expect(await repos.observations.getById('missing')).toBeNull();
  });

  it('treats the most recently fetched observation as the working state', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const other = await createTestDeck(repos);
    expect(await repos.observations.latestForDeck(deck.id)).toBeNull();

    const late = await observeTestSnapshot(repos, deck, buildSnapshot({ primer: 'late' }), {
      fetchedAt: '2026-04-02T00:00:00.000Z',
    });
    // Inserted later but fetched earlier (e.g. a delayed capture): not the working state.
    await observeTestSnapshot(repos, deck, buildSnapshot({ primer: 'early' }), {
      fetchedAt: '2026-04-01T00:00:00.000Z',
    });
    await observeTestSnapshot(repos, other, buildSnapshot({ primer: 'other deck' }), {
      fetchedAt: '2026-05-01T00:00:00.000Z',
    });
    expect((await repos.observations.latestForDeck(deck.id))?.id).toBe(late.id);

    // Same timestamp: the later insert wins.
    const tie = await observeTestSnapshot(repos, deck, buildSnapshot({ primer: 'tie' }), {
      fetchedAt: '2026-04-02T00:00:00.000Z',
    });
    expect((await repos.observations.latestForDeck(deck.id))?.id).toBe(tie.id);
  });

  it('reports dangling references as not found', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const snapshotHash = await repos.snapshots.put(buildSnapshot());
    const rawBlobHash = await repos.rawBlobs.put({ mediaType: 'application/json', data: {} });
    const base: NewObservation = {
      deckId: deck.id,
      snapshotHash,
      rawBlobHash,
      ingestMethod: 'server',
      fetchedAt: '2026-04-01T00:00:00.000Z',
      sourceVersion: null,
      sourceUpdatedAt: null,
      sourceMetadata: testSourceMetadata(deck),
      warnings: [],
    };
    await expectRepositoryError(() => repos.observations.insert({ ...base, deckId: 'missing' }), 'not-found');
    await expectRepositoryError(
      () => repos.observations.insert({ ...base, snapshotHash: '0'.repeat(64) }),
      'not-found',
    );
    await expectRepositoryError(
      () => repos.observations.insert({ ...base, rawBlobHash: '0'.repeat(64) }),
      'not-found',
    );
  });

  it('reports damaged JSON columns as corrupt data', async () => {
    const { db, repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const observation = await observeTestSnapshot(repos, deck, buildSnapshot());

    await db.run(sql`UPDATE observations SET warnings_json = '[{"code":1}]' WHERE id = ${observation.id}`);
    await expectRepositoryError(() => repos.observations.getById(observation.id), 'corrupt-data');

    await db.run(
      sql`UPDATE observations SET warnings_json = '[]', source_metadata_json = '{"source":"moxfield"}' WHERE id = ${observation.id}`,
    );
    await expectRepositoryError(() => repos.observations.getById(observation.id), 'corrupt-data');

    await db.run(
      sql`UPDATE observations SET source_metadata_json = '{}', ingest_method = 'carrier-pigeon' WHERE id = ${observation.id}`,
    );
    await expectRepositoryError(() => repos.observations.latestForDeck(deck.id), 'corrupt-data');
  });

  it('prunes superseded observations with the snapshots and raw blobs only they referenced', async () => {
    const { db, repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const other = await createTestDeck(repos);
    const state = (primer: string) => buildSnapshot({ ...baseDeckSpec(), primer });
    const committedState = state('committed');
    const commit = await commitTestSnapshot(repos, deck, committedState, {
      rawBlobHash: await repos.rawBlobs.put({ mediaType: 'application/json', data: { raw: 'committed' } }),
    });
    // The first observation shares the commit's snapshot (but not its raw blob).
    const first = await observeTestSnapshot(repos, deck, committedState, { raw: { n: 1 } });
    const second = await observeTestSnapshot(repos, deck, state('second'), { raw: { n: 2 } });
    const third = await observeTestSnapshot(repos, deck, state('third'), { raw: { n: 3 } });
    const kept = await observeTestSnapshot(repos, deck, state('kept'), { raw: { n: 4 } });
    // Another deck's observation of the same state is never touched.
    const foreign = await observeTestSnapshot(repos, other, state('second'), { raw: { n: 2 } });

    expect(await repos.transaction((tx) => tx.observations.pruneForDeck(deck.id, [kept.id, third.id]))).toBe(
      2,
    );

    for (const removed of [first, second]) expect(await repos.observations.getById(removed.id)).toBeNull();
    for (const remaining of [third, kept, foreign]) {
      expect(await repos.observations.getById(remaining.id)).toEqual(remaining);
    }
    // Still referenced: the commit's snapshot and blob, and everything the remaining
    // observations (of any deck) use. Gone: the first observation's own raw blob.
    expect(await repos.snapshots.get(commit.snapshotHash)).not.toBeNull();
    expect(await repos.rawBlobs.info(defined(commit.rawBlobHash))).not.toBeNull();
    expect(await repos.snapshots.get(second.snapshotHash)).not.toBeNull();
    expect(await repos.rawBlobs.info(second.rawBlobHash)).not.toBeNull();
    expect(await repos.rawBlobs.info(first.rawBlobHash)).toBeNull();
    expect(await countRows(db, 'snapshots')).toBe(4);
    expect(await countRows(db, 'raw_blobs')).toBe(4);
    expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);

    // Unreferenced snapshots disappear with their card index rows.
    const cards = await countRows(db, 'snapshot_cards');
    expect(await repos.transaction((tx) => tx.observations.pruneForDeck(deck.id, [kept.id]))).toBe(1);
    expect(await repos.snapshots.get(third.snapshotHash)).toBeNull();
    expect(await countRows(db, 'snapshot_cards')).toBeLessThan(cards);
    expect(await repos.transaction((tx) => tx.observations.pruneForDeck(deck.id, [kept.id]))).toBe(0);
  });
});
