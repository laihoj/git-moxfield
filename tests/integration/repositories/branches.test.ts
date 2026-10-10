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
  it('finds the main branch by kind, name and id', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const main = await repos.branches.getMain(deck.id);

    expect(main).toMatchObject({ deckId: deck.id, name: 'main', kind: 'main', headCommitId: null });
    expect(main && (await repos.branches.getByName(deck.id, 'main'))).toEqual(main);
    expect(main && (await repos.branches.getById(main.id))).toEqual(main);
    expect(await repos.branches.getMain('missing')).toBeNull();
    expect(await repos.branches.getByName(deck.id, 'experiment')).toBeNull();
    expect(await repos.branches.getById('missing')).toBeNull();
  });

  it('lists main first, then other branches by name', async () => {
    const { db, repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    for (const name of ['zz-spicy', 'aa-budget']) {
      await db.insert(branches).values({
        id: `branch-${name}`,
        deckId: deck.id,
        name,
        kind: 'experiment',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
    }
    expect((await repos.branches.list(deck.id)).map((b) => b.name)).toEqual([
      'main',
      'aa-budget',
      'zz-spicy',
    ]);
  });

  it('moves the head and marks the deck as updated', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const v1 = await commitTestSnapshot(repos, deck, buildSnapshot(baseDeckSpec()), { moveHead: false });
    const main = await repos.branches.getMain(deck.id);
    if (!main) throw new Error('main branch missing');

    await repos.branches.setHead(main.id, v1.id);

    const moved = await repos.branches.getMain(deck.id);
    expect(moved?.headCommitId).toBe(v1.id);
    expect(moved?.updatedAt).not.toBe(main.updatedAt);
    expect((await repos.decks.getById(deck.id))?.updatedAt).toBe(moved?.updatedAt);
  });

  it('supports compare-and-set on the head', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const main = await repos.branches.getMain(deck.id);
    if (!main) throw new Error('main branch missing');
    const v1 = await commitTestSnapshot(repos, deck, buildSnapshot(baseDeckSpec()), { moveHead: false });
    const v2 = await commitTestSnapshot(repos, deck, buildSnapshot({ primer: 'v2' }), {
      moveHead: false,
      parentId: v1.id,
    });

    await expectRepositoryError(
      repos.branches.setHead(main.id, v1.id, { expectedHeadCommitId: v2.id }),
      'conflict',
    );
    await repos.branches.setHead(main.id, v1.id, { expectedHeadCommitId: null });
    await expectRepositoryError(
      repos.branches.setHead(main.id, v2.id, { expectedHeadCommitId: null }),
      'conflict',
    );
    await repos.branches.setHead(main.id, v2.id, { expectedHeadCommitId: v1.id });
    expect((await repos.branches.getMain(deck.id))?.headCommitId).toBe(v2.id);
  });

  it('refuses unknown branches and commits of other decks', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const other = await createTestDeck(repos);
    const foreign = await commitTestSnapshot(repos, other, buildSnapshot(baseDeckSpec()));
    const main = await repos.branches.getMain(deck.id);
    if (!main) throw new Error('main branch missing');

    await expectRepositoryError(repos.branches.setHead('missing', foreign.id), 'not-found');
    await expectRepositoryError(repos.branches.setHead(main.id, foreign.id), 'not-found');
    await expectRepositoryError(repos.branches.setHead(main.id, 'missing'), 'not-found');
    expect((await repos.branches.getMain(deck.id))?.headCommitId).toBeNull();
  });
});
