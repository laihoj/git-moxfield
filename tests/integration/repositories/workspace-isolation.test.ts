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

async function setup() {
  const { db, repos: system } = await createTestRepositories();
  const alice = await system.users.create({ displayName: 'Alice', role: 'member' });
  const bob = await system.users.create({ displayName: 'Bob', role: 'member' });
  const bind = (workspaceId: string): Repositories =>
    createRepositories(db, {
      workspaceId,
      now: steppingClock('2026-03-01T00:00:00.000Z'),
      newId: sequentialIds(workspaceId),
    });
  const a = bind(alice.workspaceId);
  const b = bind(bob.workspaceId);

  const deck = await createTestDeck(a, { externalId: 'SharedMoxfieldDeck0001' });
  const snapshot = buildSnapshot(baseDeckSpec());
  const v1 = await commitTestSnapshot(a, deck, snapshot);
  const tag = await a.tags.add(v1.id, 'tournament');
  await a.notes.upsert(v1.id, 'note', { text: 'Top 4' });
  const observation = await observeTestSnapshot(a, deck, snapshot);
  const branch = await a.branches.getMain(deck.id);
  if (!branch) throw new Error('no main branch');
  return { db, a, b, deck, v1, tag, observation, branch, snapshot };
}

describe('workspace isolation of deck data', () => {
  it('hides another workspace’s deck from every read', async () => {
    const { a, b, deck, v1, observation, branch } = await setup();

    expect(await b.decks.getById(deck.id)).toBeNull();
    expect(await b.decks.list()).toEqual([]);
    expect(await b.decks.getBySourceExternal('moxfield', deck.externalId)).toBeNull();

    expect(await b.branches.getMain(deck.id)).toBeNull();
    expect(await b.branches.getByName(deck.id, 'main')).toBeNull();
    expect(await b.branches.getById(branch.id)).toBeNull();
    expect(await b.branches.list(deck.id)).toEqual([]);

    expect(await b.commits.getById(v1.id)).toBeNull();
    expect(await b.commits.getBySequence(deck.id, 1)).toBeNull();
    expect(await b.commits.findByIdPrefix(deck.id, v1.id.slice(0, 8))).toBeNull();
    expect(await b.commits.head(deck.id)).toBeNull();
    expect(await b.commits.lineage(deck.id)).toEqual([]);
    expect(await b.commits.lineage(deck.id, v1.id)).toEqual([]);
    expect(await b.commits.listForDeck(deck.id)).toEqual([]);
    expect(await b.commits.count(deck.id)).toBe(0);
    expect(await b.commits.maxSequence(deck.id)).toBeNull();

    expect(await b.observations.getById(observation.id)).toBeNull();
    expect(await b.observations.latestForDeck(deck.id)).toBeNull();

    expect(await b.tags.listForCommit(v1.id)).toEqual([]);
    expect(await b.tags.listForCommits([v1.id])).toEqual(new Map([[v1.id, []]]));
    expect(await b.tags.listForDeck(deck.id)).toEqual([]);
    expect(await b.tags.commitsWithTag(deck.id, 'tournament')).toEqual([]);

    expect(await b.notes.get(v1.id, 'note')).toBeNull();
    expect(await b.notes.listForCommit(v1.id)).toEqual([]);

    expect(await b.cardIndex.versionsContainingCard(deck.id, 'Sol Ring')).toEqual([]);
    expect(await b.cardIndex.searchCardsInDeck(deck.id, 'sol')).toEqual([]);

    // The owner still sees everything.
    expect((await a.commits.head(deck.id))?.id).toBe(v1.id);
    expect((await a.cardIndex.searchCardsInDeck(deck.id, 'sol')).length).toBeGreaterThan(0);
    expect(await a.cardIndex.versionsContainingCard(deck.id, 'Sol Ring')).toHaveLength(1);
  });

  it('refuses or ignores every write to another workspace’s deck', async () => {
    const { db, a, b, deck, v1, observation, branch } = await setup();
    const counts = async () =>
      Object.fromEntries(
        await Promise.all(
          ['decks', 'branches', 'commits', 'observations', 'version_tags', 'commit_notes'].map(
            async (table) => [table, await countRows(db, table)] as const,
          ),
        ),
      );
    const before = await counts();

    await expectRepositoryError(
      () => b.decks.updateCachedInfo(deck.id, { name: 'X', format: 'x', url: 'x' }),
      'not-found',
    );
    await expectRepositoryError(b.decks.recordFetchAttempt(deck.id, '2026-03-02T00:00:00.000Z'), 'not-found');
    await expectRepositoryError(b.decks.recordFetchError(deck.id, null), 'not-found');
    expect(await b.decks.delete(deck.id)).toBe(false);

    await expectRepositoryError(b.branches.setHead(branch.id, v1.id), 'not-found');
    await expectRepositoryError(() => b.commits.insert({ ...v1, sequence: 2, parentId: v1.id }), 'not-found');
    const { id: _id, ...observed } = observation;
    await expectRepositoryError(() => b.observations.insert(observed), 'not-found');
    expect(await b.observations.pruneForDeck(deck.id, [])).toBe(0);

    await expectRepositoryError(() => b.tags.add(v1.id, 'stolen'), 'not-found');
    expect(await b.tags.remove(v1.id, 'tournament')).toBe(false);
    await expectRepositoryError(() => b.notes.upsert(v1.id, 'note', { text: 'Overwritten' }), 'not-found');
    expect(await b.notes.delete(v1.id, 'note')).toBe(false);

    expect(await counts()).toEqual(before);
    expect((await a.decks.getById(deck.id))?.name).toBe(deck.name);
    expect(await a.tags.listForCommit(v1.id)).toEqual(['tournament']);
    expect((await a.notes.get(v1.id, 'note'))?.data).toEqual({ text: 'Top 4' });
    expect((await a.observations.latestForDeck(deck.id))?.id).toBe(observation.id);
  });

  it('lets two workspaces track the same source deck independently', async () => {
    const { a, b, deck } = await setup();
    const own = await createTestDeck(b, { externalId: deck.externalId });
    expect(own.id).not.toBe(deck.id);
    expect((await b.decks.list()).map((entry) => entry.id)).toEqual([own.id]);
    expect((await a.decks.list()).map((entry) => entry.id)).toEqual([deck.id]);
    expect(await b.decks.delete(own.id)).toBe(true);
    expect(await a.decks.getById(deck.id)).not.toBeNull();
  });
});
