import { describe, expect, it } from 'vitest';

import { baseDeckSpec, buildSnapshot } from '@tests/support/builders';
import {
  commitTestSnapshot,
  commitTestSnapshots,
  countRows,
  createTestDeck,
  createTestRepositories,
  expectRepositoryError,
} from '@tests/support/db';

function version(n: number): ReturnType<typeof buildSnapshot> {
  return buildSnapshot({ ...baseDeckSpec(), primer: `v${n}` });
}

describe('version tags repository', () => {
  it('adds normalized tags idempotently and lists them sorted', async () => {
    const { db, repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const v1 = await commitTestSnapshot(repos, deck, version(1));

    expect(await repos.tags.add(v1.id, '  Tournament ')).toBe('tournament');
    expect(await repos.tags.add(v1.id, 'TOURNAMENT')).toBe('tournament');
    expect(await repos.tags.add(v1.id, 'Stable')).toBe('stable');
    expect(await repos.tags.add(v1.id, 'budget')).toBe('budget');

    expect(await repos.tags.listForCommit(v1.id)).toEqual(['budget', 'stable', 'tournament']);
    expect(await countRows(db, 'version_tags')).toBe(3);
    expect(await repos.tags.listForCommit('missing')).toEqual([]);
  });

  it('rejects invalid tags and unknown commits', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const v1 = await commitTestSnapshot(repos, deck, version(1));

    expect((await expectRepositoryError(() => repos.tags.add(v1.id, '  '), 'invalid-input')).message).toBe(
      'Enter a tag.',
    );
    await expectRepositoryError(() => repos.tags.add(v1.id, 'a/b'), 'invalid-input');
    await expectRepositoryError(() => repos.tags.add('missing', 'stable'), 'not-found');
  });

  it('removes tags given in any spelling', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const v1 = await commitTestSnapshot(repos, deck, version(1));
    await repos.tags.add(v1.id, 'top 8');

    expect(await repos.tags.remove(v1.id, ' TOP   8 ')).toBe(true);
    expect(await repos.tags.remove(v1.id, 'top 8')).toBe(false);
    expect(await repos.tags.remove(v1.id, '')).toBe(false);
    expect(await repos.tags.listForCommit(v1.id)).toEqual([]);
  });

  it('lists tags for many commits, including untagged ones', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const [v1, v2, v3] = await commitTestSnapshots(repos, deck, [1, 2, 3].map(version));
    if (!v1 || !v2 || !v3) throw new Error('commits missing');
    await repos.tags.add(v1.id, 'stable');
    await repos.tags.add(v1.id, 'budget');
    await repos.tags.add(v3.id, 'tournament');

    const tags = await repos.tags.listForCommits([v1.id, v2.id, v3.id, v1.id]);

    expect([...tags.entries()]).toEqual([
      [v1.id, ['budget', 'stable']],
      [v2.id, []],
      [v3.id, ['tournament']],
    ]);
    expect((await repos.tags.listForCommits([])).size).toBe(0);
  });

  it('counts tag usage per deck', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const other = await createTestDeck(repos);
    const [v1, v2, v3] = await commitTestSnapshots(repos, deck, [1, 2, 3].map(version));
    if (!v1 || !v2 || !v3) throw new Error('commits missing');
    const foreign = await commitTestSnapshot(repos, other, version(1));
    await repos.tags.add(v1.id, 'stable');
    await repos.tags.add(v3.id, 'stable');
    await repos.tags.add(v2.id, 'tournament');
    await repos.tags.add(v3.id, 'budget');
    await repos.tags.add(foreign.id, 'stable');
    await repos.tags.add(foreign.id, 'casual');

    expect(await repos.tags.listForDeck(deck.id)).toEqual([
      { name: 'budget', count: 1 },
      { name: 'stable', count: 2 },
      { name: 'tournament', count: 1 },
    ]);
    expect(await repos.tags.listForDeck((await createTestDeck(repos)).id)).toEqual([]);
  });

  it('finds the versions carrying a tag, newest first', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const other = await createTestDeck(repos);
    const [v1, v2, v3] = await commitTestSnapshots(repos, deck, [1, 2, 3].map(version));
    if (!v1 || !v2 || !v3) throw new Error('commits missing');
    await repos.tags.add(v1.id, 'stable');
    await repos.tags.add(v3.id, 'stable');
    await repos.tags.add((await commitTestSnapshot(repos, other, version(1))).id, 'stable');

    expect(await repos.tags.commitsWithTag(deck.id, ' STABLE ')).toEqual([v3, v1]);
    expect(await repos.tags.commitsWithTag(deck.id, 'tournament')).toEqual([]);
    expect(await repos.tags.commitsWithTag(deck.id, '!!')).toEqual([]);
  });
});
