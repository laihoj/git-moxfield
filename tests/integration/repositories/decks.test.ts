import { describe, expect, it } from 'vitest';

import { workspaces } from '@/server/db/schema';
import { createRepositories, type FetchErrorRecord } from '@/server/repositories';
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
  it('creates a deck in the local workspace together with its main branch', () => {
    const { repos } = createTestRepositories();
    const deck = repos.decks.create({
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
    expect(repos.branches.list(deck.id)).toEqual([
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

  it('uses random UUIDs by default', () => {
    const { db } = createTestRepositories();
    const repos = createRepositories(db);
    const deck = createTestDeck(repos);
    expect(deck.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('refuses to track the same source deck twice', () => {
    const { db, repos } = createTestRepositories();
    createTestDeck(repos, { externalId: 'SameDeck' });
    expectRepositoryError(() => createTestDeck(repos, { externalId: 'SameDeck' }), 'conflict');
    expect(countRows(db, 'decks')).toBe(1);
    expect(countRows(db, 'branches')).toBe(1);
    // The same external id on another source is a different deck.
    expect(createTestDeck(repos, { source: 'archidekt', externalId: 'SameDeck' }).source).toBe('archidekt');
  });

  it('rejects decks without a source or external id', () => {
    const { repos } = createTestRepositories();
    expectRepositoryError(() => createTestDeck(repos, { externalId: '  ' }), 'invalid-input');
    expectRepositoryError(() => createTestDeck(repos, { source: '' }), 'invalid-input');
  });

  it('looks decks up by id and by source + external id', () => {
    const { repos } = createTestRepositories();
    const deck = createTestDeck(repos, { externalId: 'LookupDeck' });

    expect(repos.decks.getById(deck.id)).toEqual(deck);
    expect(repos.decks.getBySourceExternal('moxfield', 'LookupDeck')).toEqual(deck);
    expect(repos.decks.getById('missing')).toBeNull();
    expect(repos.decks.getBySourceExternal('moxfield', 'lookupdeck')).toBeNull();
    expect(repos.decks.getBySourceExternal('archidekt', 'LookupDeck')).toBeNull();
  });

  it('lists decks most recently updated first', () => {
    const { repos } = createTestRepositories();
    const first = createTestDeck(repos, { name: 'First' });
    const second = createTestDeck(repos, { name: 'Second' });
    const third = createTestDeck(repos, { name: 'Third' });
    expect(repos.decks.list().map((d) => d.name)).toEqual(['Third', 'Second', 'First']);

    expect(
      repos.decks.updateCachedInfo(first.id, {
        name: 'First (renamed)',
        format: first.format,
        url: first.url,
      }),
    ).toBe(true);
    expect(repos.decks.list().map((d) => d.id)).toEqual([first.id, third.id, second.id]);

    // A new version also counts as an update.
    commitTestSnapshot(repos, second, buildSnapshot(baseDeckSpec()));
    expect(repos.decks.list().map((d) => d.id)).toEqual([second.id, first.id, third.id]);
  });

  it('only bumps updatedAt when cached info actually changes', () => {
    const { repos } = createTestRepositories();
    const deck = createTestDeck(repos);

    expect(
      repos.decks.updateCachedInfo(deck.id, { name: deck.name, format: deck.format, url: deck.url }),
    ).toBe(false);
    expect(repos.decks.getById(deck.id)?.updatedAt).toBe(deck.updatedAt);

    expect(repos.decks.updateCachedInfo(deck.id, { name: deck.name, format: 'modern', url: deck.url })).toBe(
      true,
    );
    const updated = repos.decks.getById(deck.id);
    expect(updated?.format).toBe('modern');
    expect(updated?.updatedAt).not.toBe(deck.updatedAt);

    expectRepositoryError(
      () => repos.decks.updateCachedInfo('missing', { name: 'x', format: 'y', url: 'z' }),
      'not-found',
    );
  });

  it('records fetch attempts and errors without reordering the deck list', () => {
    const { repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    const error: FetchErrorRecord = {
      code: 'rate-limited',
      message: 'Moxfield asked us to slow down',
      at: '2026-03-01T10:00:00.000Z',
      retryAfterSeconds: 30,
    };

    repos.decks.recordFetchAttempt(deck.id, '2026-03-01T10:00:00.000Z');
    repos.decks.recordFetchError(deck.id, error);
    const failed = repos.decks.getById(deck.id);
    expect(failed?.lastFetchAttemptAt).toBe('2026-03-01T10:00:00.000Z');
    expect(failed?.lastFetchError).toEqual(error);
    expect(failed?.updatedAt).toBe(deck.updatedAt);

    repos.decks.recordFetchError(deck.id, null);
    expect(repos.decks.getById(deck.id)?.lastFetchError).toBeNull();

    expectRepositoryError(() => {
      repos.decks.recordFetchAttempt('missing', error.at);
    }, 'not-found');
    expectRepositoryError(() => {
      repos.decks.recordFetchError('missing', null);
    }, 'not-found');
  });

  it('reports a damaged fetch error column as corrupt data', () => {
    const { db, repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    db.$client
      .prepare('UPDATE decks SET last_fetch_error_json = ? WHERE id = ?')
      .run('{"code":"teapot"}', deck.id);
    expectRepositoryError(() => repos.decks.getById(deck.id), 'corrupt-data');
  });

  it('deletes a deck with its entire history, bypassing commit immutability', () => {
    const { db, repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    const other = createTestDeck(repos);
    const shared = buildSnapshot(baseDeckSpec());
    const own = buildSnapshot({ ...baseDeckSpec(), primer: 'Only in the deleted deck.\n' });

    const v1 = commitTestSnapshot(repos, deck, shared);
    const v2 = commitTestSnapshot(repos, deck, own);
    observeTestSnapshot(repos, deck, own, { raw: { only: 'deleted deck' } });
    repos.tags.add(v1.id, 'stable');
    repos.notes.upsert(v2.id, 'text', { text: 'Testing a new combo' });
    const kept = commitTestSnapshot(repos, other, shared);
    observeTestSnapshot(repos, other, shared, { raw: { only: 'kept deck' } });

    expect(repos.decks.delete(deck.id)).toBe(true);

    expect(repos.decks.getById(deck.id)).toBeNull();
    expect(repos.commits.getById(v1.id)).toBeNull();
    expect(repos.commits.getById(v2.id)).toBeNull();
    expect(repos.observations.latestForDeck(deck.id)).toBeNull();
    expect(repos.branches.list(deck.id)).toEqual([]);
    expect(countRows(db, 'version_tags')).toBe(0);
    expect(countRows(db, 'commit_notes')).toBe(0);

    // Content only the deleted deck referenced is garbage-collected; shared content stays.
    expect(repos.snapshots.get(v2.snapshotHash)).toBeNull();
    expect(repos.snapshots.get(kept.snapshotHash)).toEqual(shared);
    expect(countRows(db, 'snapshots')).toBe(1);
    expect(countRows(db, 'raw_blobs')).toBe(1);
    const indexed = db.$client.prepare('SELECT DISTINCT snapshot_hash AS hash FROM snapshot_cards').all();
    expect(indexed).toEqual([{ hash: kept.snapshotHash }]);

    // The other deck is untouched.
    expect(repos.commits.lineage(other.id).map((c) => c.id)).toEqual([kept.id]);
    expect(repos.decks.delete(deck.id)).toBe(false);
  });

  it('scopes decks to the configured workspace', () => {
    const { db, repos } = createTestRepositories();
    db.insert(workspaces).values({ id: 'team', name: 'Team', createdAt: '2026-01-01T00:00:00.000Z' }).run();
    const team = createRepositories(db, { workspaceId: 'team' });
    const local = createTestDeck(repos, { externalId: 'SharedId' });
    const teamDeck = createTestDeck(team, { externalId: 'SharedId' });

    expect(team.decks.list().map((d) => d.id)).toEqual([teamDeck.id]);
    expect(team.decks.getById(local.id)).toBeNull();
    expect(repos.decks.getBySourceExternal('moxfield', 'SharedId')?.id).toBe(local.id);
    expect(team.decks.delete(local.id)).toBe(false);
    expect(repos.decks.getById(local.id)).not.toBeNull();
  });
});
