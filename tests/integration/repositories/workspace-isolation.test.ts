/**
 * Every deck-reachable repository query is scoped to the bound workspace: given ids of
 * another workspace's deck, commits or observations, reads find nothing and writes fail
 * with `not-found` (or change nothing), exactly as for ids that do not exist.
 */
import { describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '@/server/repositories';
import { baseDeckSpec, buildSnapshot } from '@tests/support/builders';
import {
  commitTestSnapshot,
  countRows,
  createTestDeck,
  createTestRepositories,
  expectRepositoryError,
  observeTestSnapshot,
  sequentialIds,
  steppingClock,
} from '@tests/support/db';

function setup() {
  const { db, repos: system } = createTestRepositories();
  const alice = system.users.create({ displayName: 'Alice', role: 'member' });
  const bob = system.users.create({ displayName: 'Bob', role: 'member' });
  const bind = (workspaceId: string): Repositories =>
    createRepositories(db, {
      workspaceId,
      now: steppingClock('2026-03-01T00:00:00.000Z'),
      newId: sequentialIds(workspaceId),
    });
  const a = bind(alice.workspaceId);
  const b = bind(bob.workspaceId);

  const deck = createTestDeck(a, { externalId: 'SharedMoxfieldDeck0001' });
  const snapshot = buildSnapshot(baseDeckSpec());
  const v1 = commitTestSnapshot(a, deck, snapshot);
  const tag = a.tags.add(v1.id, 'tournament');
  a.notes.upsert(v1.id, 'note', { text: 'Top 4' });
  const observation = observeTestSnapshot(a, deck, snapshot);
  const branch = a.branches.getMain(deck.id);
  if (!branch) throw new Error('no main branch');
  return { db, a, b, deck, v1, tag, observation, branch, snapshot };
}

describe('workspace isolation of deck data', () => {
  it('hides another workspace’s deck from every read', () => {
    const { a, b, deck, v1, observation, branch } = setup();

    expect(b.decks.getById(deck.id)).toBeNull();
    expect(b.decks.list()).toEqual([]);
    expect(b.decks.getBySourceExternal('moxfield', deck.externalId)).toBeNull();

    expect(b.branches.getMain(deck.id)).toBeNull();
    expect(b.branches.getByName(deck.id, 'main')).toBeNull();
    expect(b.branches.getById(branch.id)).toBeNull();
    expect(b.branches.list(deck.id)).toEqual([]);

    expect(b.commits.getById(v1.id)).toBeNull();
    expect(b.commits.getBySequence(deck.id, 1)).toBeNull();
    expect(b.commits.findByIdPrefix(deck.id, v1.id.slice(0, 8))).toBeNull();
    expect(b.commits.head(deck.id)).toBeNull();
    expect(b.commits.lineage(deck.id)).toEqual([]);
    expect(b.commits.lineage(deck.id, v1.id)).toEqual([]);
    expect(b.commits.listForDeck(deck.id)).toEqual([]);
    expect(b.commits.count(deck.id)).toBe(0);
    expect(b.commits.maxSequence(deck.id)).toBeNull();

    expect(b.observations.getById(observation.id)).toBeNull();
    expect(b.observations.latestForDeck(deck.id)).toBeNull();

    expect(b.tags.listForCommit(v1.id)).toEqual([]);
    expect(b.tags.listForCommits([v1.id])).toEqual(new Map([[v1.id, []]]));
    expect(b.tags.listForDeck(deck.id)).toEqual([]);
    expect(b.tags.commitsWithTag(deck.id, 'tournament')).toEqual([]);

    expect(b.notes.get(v1.id, 'note')).toBeNull();
    expect(b.notes.listForCommit(v1.id)).toEqual([]);

    expect(b.cardIndex.versionsContainingCard(deck.id, 'Sol Ring')).toEqual([]);
    expect(b.cardIndex.searchCardsInDeck(deck.id, 'sol')).toEqual([]);

    // The owner still sees everything.
    expect(a.commits.head(deck.id)?.id).toBe(v1.id);
    expect(a.cardIndex.searchCardsInDeck(deck.id, 'sol').length).toBeGreaterThan(0);
    expect(a.cardIndex.versionsContainingCard(deck.id, 'Sol Ring')).toHaveLength(1);
  });

  it('refuses or ignores every write to another workspace’s deck', () => {
    const { db, a, b, deck, v1, observation, branch } = setup();
    const counts = () =>
      Object.fromEntries(
        ['decks', 'branches', 'commits', 'observations', 'version_tags', 'commit_notes'].map((table) => [
          table,
          countRows(db, table),
        ]),
      );
    const before = counts();

    expectRepositoryError(
      () => b.decks.updateCachedInfo(deck.id, { name: 'X', format: 'x', url: 'x' }),
      'not-found',
    );
    expectRepositoryError(() => {
      b.decks.recordFetchAttempt(deck.id, '2026-03-02T00:00:00.000Z');
    }, 'not-found');
    expectRepositoryError(() => {
      b.decks.recordFetchError(deck.id, null);
    }, 'not-found');
    expect(b.decks.delete(deck.id)).toBe(false);

    expectRepositoryError(() => {
      b.branches.setHead(branch.id, v1.id);
    }, 'not-found');
    expectRepositoryError(() => b.commits.insert({ ...v1, sequence: 2, parentId: v1.id }), 'not-found');
    const { id: _id, ...observed } = observation;
    expectRepositoryError(() => b.observations.insert(observed), 'not-found');
    expect(b.observations.pruneForDeck(deck.id, [])).toBe(0);

    expectRepositoryError(() => b.tags.add(v1.id, 'stolen'), 'not-found');
    expect(b.tags.remove(v1.id, 'tournament')).toBe(false);
    expectRepositoryError(() => b.notes.upsert(v1.id, 'note', { text: 'Overwritten' }), 'not-found');
    expect(b.notes.delete(v1.id, 'note')).toBe(false);

    expect(counts()).toEqual(before);
    expect(a.decks.getById(deck.id)?.name).toBe(deck.name);
    expect(a.tags.listForCommit(v1.id)).toEqual(['tournament']);
    expect(a.notes.get(v1.id, 'note')?.data).toEqual({ text: 'Top 4' });
    expect(a.observations.latestForDeck(deck.id)?.id).toBe(observation.id);
  });

  it('lets two workspaces track the same source deck independently', () => {
    const { a, b, deck } = setup();
    const own = createTestDeck(b, { externalId: deck.externalId });
    expect(own.id).not.toBe(deck.id);
    expect(b.decks.list().map((entry) => entry.id)).toEqual([own.id]);
    expect(a.decks.list().map((entry) => entry.id)).toEqual([deck.id]);
    expect(b.decks.delete(own.id)).toBe(true);
    expect(a.decks.getById(deck.id)).not.toBeNull();
  });
});
