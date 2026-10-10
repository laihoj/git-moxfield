import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { workspaces } from '@/server/db/schema';
import { createRepositories, RepositoryError, type FetchErrorRecord } from '@/server/repositories';
import { baseDeckSpec, buildSnapshot } from '@tests/support/builders';
import {
  commitTestSnapshot,
  countRows,
  createTestDeck,
  createTestRepositories,
  expectRepositoryError,
  observeTestSnapshot,
} from '@tests/support/db';

describe('decks repository', () => {
  it('creates a deck in the local workspace together with its main branch', async () => {
    const { repos } = await createTestRepositories();
    const deck = await repos.decks.create({
      source: 'moxfield',
      externalId: 'AbCdEfGhIjKlMnOpQrStUv',
      url: 'https://moxfield.com/decks/AbCdEfGhIjKlMnOpQrStUv',
      name: 'Blue Farm',
      format: 'commander',
    });

    expect(deck).toEqual({
      id: 'id-0001',
      workspaceId: 'local',
      source: 'moxfield',
      externalId: 'AbCdEfGhIjKlMnOpQrStUv',
      url: 'https://moxfield.com/decks/AbCdEfGhIjKlMnOpQrStUv',
      name: 'Blue Farm',
      format: 'commander',
      headBranchName: 'main',
      lastFetchAttemptAt: null,
      lastFetchError: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await repos.branches.list(deck.id)).toEqual([
      {
        id: 'id-0002',
        deckId: deck.id,
        name: 'main',
        kind: 'main',
        headCommitId: null,
        baseCommitId: null,
        description: null,
        createdAt: deck.createdAt,
        updatedAt: deck.createdAt,
      },
    ]);
  });

  it('uses random UUIDs by default', async () => {
    const { db } = await createTestRepositories();
    const repos = createRepositories(db);
    const deck = await createTestDeck(repos);
    expect(deck.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('refuses to track the same source deck twice', async () => {
    const { db, repos } = await createTestRepositories();
    await createTestDeck(repos, { externalId: 'SameDeck' });
    await expectRepositoryError(() => createTestDeck(repos, { externalId: 'SameDeck' }), 'conflict');
    expect(await countRows(db, 'decks')).toBe(1);
    expect(await countRows(db, 'branches')).toBe(1);
    // The same external id on another source is a different deck.
    expect((await createTestDeck(repos, { source: 'archidekt', externalId: 'SameDeck' })).source).toBe(
      'archidekt',
    );
  });

  it('reports a concurrent duplicate as a conflict, leaving no partial deck behind', async () => {
    const { db, repos } = await createTestRepositories();
    // Both requests check before either inserts; the unique index decides.
    const results = await Promise.allSettled([
      createTestDeck(repos, { externalId: 'RacedDeck' }),
      createTestDeck(repos, { externalId: 'RacedDeck' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const failure = results.find((result) => result.status === 'rejected');
    expect(failure?.reason).toBeInstanceOf(RepositoryError);
    expect(failure?.reason).toMatchObject({ code: 'conflict' });
    expect(await countRows(db, 'decks')).toBe(1);
    expect(await countRows(db, 'branches')).toBe(1);
  });

  it('rejects decks without a source or external id', async () => {
    const { repos } = await createTestRepositories();
    await expectRepositoryError(() => createTestDeck(repos, { externalId: '  ' }), 'invalid-input');
    await expectRepositoryError(() => createTestDeck(repos, { source: '' }), 'invalid-input');
  });

  it('looks decks up by id and by source + external id', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos, { externalId: 'LookupDeck' });

    expect(await repos.decks.getById(deck.id)).toEqual(deck);
    expect(await repos.decks.getBySourceExternal('moxfield', 'LookupDeck')).toEqual(deck);
    expect(await repos.decks.getById('missing')).toBeNull();
    expect(await repos.decks.getBySourceExternal('moxfield', 'lookupdeck')).toBeNull();
    expect(await repos.decks.getBySourceExternal('archidekt', 'LookupDeck')).toBeNull();
  });

  it('lists decks most recently updated first', async () => {
    const { repos } = await createTestRepositories();
    const first = await createTestDeck(repos, { name: 'First' });
    const second = await createTestDeck(repos, { name: 'Second' });
    const third = await createTestDeck(repos, { name: 'Third' });
    expect((await repos.decks.list()).map((d) => d.name)).toEqual(['Third', 'Second', 'First']);

    expect(
      await repos.decks.updateCachedInfo(first.id, {
        name: 'First (renamed)',
        format: first.format,
        url: first.url,
      }),
    ).toBe(true);
    expect((await repos.decks.list()).map((d) => d.id)).toEqual([first.id, third.id, second.id]);

    // A new version also counts as an update.
    await commitTestSnapshot(repos, second, buildSnapshot(baseDeckSpec()));
    expect((await repos.decks.list()).map((d) => d.id)).toEqual([second.id, first.id, third.id]);
  });

  it('only bumps updatedAt when cached info actually changes', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);

    expect(
      await repos.decks.updateCachedInfo(deck.id, { name: deck.name, format: deck.format, url: deck.url }),
    ).toBe(false);
    expect((await repos.decks.getById(deck.id))?.updatedAt).toBe(deck.updatedAt);

    expect(
      await repos.decks.updateCachedInfo(deck.id, { name: deck.name, format: 'modern', url: deck.url }),
    ).toBe(true);
    const updated = await repos.decks.getById(deck.id);
    expect(updated?.format).toBe('modern');
    expect(updated?.updatedAt).not.toBe(deck.updatedAt);

    await expectRepositoryError(
      () => repos.decks.updateCachedInfo('missing', { name: 'x', format: 'y', url: 'z' }),
      'not-found',
    );
  });

  it('records fetch attempts and errors without reordering the deck list', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const error: FetchErrorRecord = {
      code: 'rate-limited',
      message: 'Moxfield asked us to slow down',
      at: '2026-03-01T10:00:00.000Z',
      retryAfterSeconds: 30,
    };

    await repos.decks.recordFetchAttempt(deck.id, '2026-03-01T10:00:00.000Z');
    await repos.decks.recordFetchError(deck.id, error);
    const failed = await repos.decks.getById(deck.id);
    expect(failed?.lastFetchAttemptAt).toBe('2026-03-01T10:00:00.000Z');
    expect(failed?.lastFetchError).toEqual(error);
    expect(failed?.updatedAt).toBe(deck.updatedAt);

    await repos.decks.recordFetchError(deck.id, null);
    expect((await repos.decks.getById(deck.id))?.lastFetchError).toBeNull();

    await expectRepositoryError(repos.decks.recordFetchAttempt('missing', error.at), 'not-found');
    await expectRepositoryError(repos.decks.recordFetchError('missing', null), 'not-found');
  });

  it('reports a damaged fetch error column as corrupt data', async () => {
    const { db, repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    await db.run(sql`UPDATE decks SET last_fetch_error_json = ${'{"code":"teapot"}'} WHERE id = ${deck.id}`);
    await expectRepositoryError(() => repos.decks.getById(deck.id), 'corrupt-data');
  });

  it('deletes a deck with its entire history, bypassing commit immutability', async () => {
    const { db, repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const other = await createTestDeck(repos);
    const shared = buildSnapshot(baseDeckSpec());
    const own = buildSnapshot({ ...baseDeckSpec(), primer: 'Only in the deleted deck.\n' });

    const v1 = await commitTestSnapshot(repos, deck, shared);
    const v2 = await commitTestSnapshot(repos, deck, own);
    await observeTestSnapshot(repos, deck, own, { raw: { only: 'deleted deck' } });
    await repos.tags.add(v1.id, 'stable');
    await repos.notes.upsert(v2.id, 'text', { text: 'Testing a new combo' });
    const kept = await commitTestSnapshot(repos, other, shared);
    await observeTestSnapshot(repos, other, shared, { raw: { only: 'kept deck' } });

    expect(await repos.decks.delete(deck.id)).toBe(true);

    expect(await repos.decks.getById(deck.id)).toBeNull();
    expect(await repos.commits.getById(v1.id)).toBeNull();
    expect(await repos.commits.getById(v2.id)).toBeNull();
    expect(await repos.observations.latestForDeck(deck.id)).toBeNull();
    expect(await repos.branches.list(deck.id)).toEqual([]);
    expect(await countRows(db, 'version_tags')).toBe(0);
    expect(await countRows(db, 'commit_notes')).toBe(0);

    // Content only the deleted deck referenced is garbage-collected; shared content stays.
    expect(await repos.snapshots.get(v2.snapshotHash)).toBeNull();
    expect(await repos.snapshots.get(kept.snapshotHash)).toEqual(shared);
    expect(await countRows(db, 'snapshots')).toBe(1);
    expect(await countRows(db, 'raw_blobs')).toBe(1);
    const indexed = await db.all(sql`SELECT DISTINCT snapshot_hash AS hash FROM snapshot_cards`);
    expect(indexed).toEqual([{ hash: kept.snapshotHash }]);

    // The other deck is untouched.
    expect((await repos.commits.lineage(other.id)).map((c) => c.id)).toEqual([kept.id]);
    expect(await repos.decks.delete(deck.id)).toBe(false);
  });

  it('scopes decks to the configured workspace', async () => {
    const { db, repos } = await createTestRepositories();
    await db.insert(workspaces).values({ id: 'team', name: 'Team', createdAt: '2026-01-01T00:00:00.000Z' });
    const team = createRepositories(db, { workspaceId: 'team' });
    const local = await createTestDeck(repos, { externalId: 'SharedId' });
    const teamDeck = await createTestDeck(team, { externalId: 'SharedId' });

    expect((await team.decks.list()).map((d) => d.id)).toEqual([teamDeck.id]);
    expect(await team.decks.getById(local.id)).toBeNull();
    expect((await repos.decks.getBySourceExternal('moxfield', 'SharedId'))?.id).toBe(local.id);
    expect(await team.decks.delete(local.id)).toBe(false);
    expect(await repos.decks.getById(local.id)).not.toBeNull();
  });
});
