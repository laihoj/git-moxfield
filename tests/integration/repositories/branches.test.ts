import { describe, expect, it } from 'vitest';

import { branches } from '@/server/db/schema';
import { baseDeckSpec, buildSnapshot } from '@tests/support/builders';
import {
  commitTestSnapshot,
  createTestDeck,
  createTestRepositories,
  expectRepositoryError,
} from '@tests/support/db';

describe('branches repository', () => {
  it('finds the main branch by kind, name and id', () => {
    const { repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    const main = repos.branches.getMain(deck.id);

    expect(main).toMatchObject({ deckId: deck.id, name: 'main', kind: 'main', headCommitId: null });
    expect(main && repos.branches.getByName(deck.id, 'main')).toEqual(main);
    expect(main && repos.branches.getById(main.id)).toEqual(main);
    expect(repos.branches.getMain('missing')).toBeNull();
    expect(repos.branches.getByName(deck.id, 'experiment')).toBeNull();
    expect(repos.branches.getById('missing')).toBeNull();
  });

  it('lists main first, then other branches by name', () => {
    const { db, repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    for (const name of ['zz-spicy', 'aa-budget']) {
      db.insert(branches)
        .values({
          id: `branch-${name}`,
          deckId: deck.id,
          name,
          kind: 'experiment',
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        })
        .run();
    }
    expect(repos.branches.list(deck.id).map((b) => b.name)).toEqual(['main', 'aa-budget', 'zz-spicy']);
  });

  it('moves the head and marks the deck as updated', () => {
    const { repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    const v1 = commitTestSnapshot(repos, deck, buildSnapshot(baseDeckSpec()), { moveHead: false });
    const main = repos.branches.getMain(deck.id);
    if (!main) throw new Error('main branch missing');

    repos.branches.setHead(main.id, v1.id);

    const moved = repos.branches.getMain(deck.id);
    expect(moved?.headCommitId).toBe(v1.id);
    expect(moved?.updatedAt).not.toBe(main.updatedAt);
    expect(repos.decks.getById(deck.id)?.updatedAt).toBe(moved?.updatedAt);
  });

  it('supports compare-and-set on the head', () => {
    const { repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    const main = repos.branches.getMain(deck.id);
    if (!main) throw new Error('main branch missing');
    const v1 = commitTestSnapshot(repos, deck, buildSnapshot(baseDeckSpec()), { moveHead: false });
    const v2 = commitTestSnapshot(repos, deck, buildSnapshot({ primer: 'v2' }), {
      moveHead: false,
      parentId: v1.id,
    });

    expectRepositoryError(() => {
      repos.branches.setHead(main.id, v1.id, { expectedHeadCommitId: v2.id });
    }, 'conflict');
    repos.branches.setHead(main.id, v1.id, { expectedHeadCommitId: null });
    expectRepositoryError(() => {
      repos.branches.setHead(main.id, v2.id, { expectedHeadCommitId: null });
    }, 'conflict');
    repos.branches.setHead(main.id, v2.id, { expectedHeadCommitId: v1.id });
    expect(repos.branches.getMain(deck.id)?.headCommitId).toBe(v2.id);
  });

  it('refuses unknown branches and commits of other decks', () => {
    const { repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    const other = createTestDeck(repos);
    const foreign = commitTestSnapshot(repos, other, buildSnapshot(baseDeckSpec()));
    const main = repos.branches.getMain(deck.id);
    if (!main) throw new Error('main branch missing');

    expectRepositoryError(() => {
      repos.branches.setHead('missing', foreign.id);
    }, 'not-found');
    expectRepositoryError(() => {
      repos.branches.setHead(main.id, foreign.id);
    }, 'not-found');
    expectRepositoryError(() => {
      repos.branches.setHead(main.id, 'missing');
    }, 'not-found');
    expect(repos.branches.getMain(deck.id)?.headCommitId).toBeNull();
  });
});
