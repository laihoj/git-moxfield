import { describe, expect, it } from 'vitest';

import { MAX_VERSION_TAG_LENGTH, normalizeVersionTag } from '@/server/repositories';
import { baseDeckSpec, buildSnapshot } from '@tests/support/builders';
import {
  commitTestSnapshot,
  countRows,
  createTestDeck,
  createTestRepositories,
  expectRepositoryError,
} from '@tests/support/db';

function version(n: number): ReturnType<typeof buildSnapshot> {
  return buildSnapshot({ ...baseDeckSpec(), primer: `v${n}` });
}

describe('normalizeVersionTag', () => {
  it.each([
    ['tournament', 'tournament'],
    ['  Tournament ', 'tournament'],
    ['Top \t  8', 'top 8'],
    ['Pre-Ban_v1.2', 'pre-ban_v1.2'],
    ['Présence', 'présence'],
    ['ÉTÉ', 'été'],
    ['東京 2026', '東京 2026'],
    ['x'.repeat(MAX_VERSION_TAG_LENGTH), 'x'.repeat(MAX_VERSION_TAG_LENGTH)],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeVersionTag(input)).toEqual({ ok: true, name: expected });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['x'.repeat(MAX_VERSION_TAG_LENGTH + 1), 'at most 40'],
    ['tournament/finals', 'may contain'],
    ['stable!', 'may contain'],
    ['🔥', 'may contain'],
    ['...', 'may contain'],
    ['-_-', 'may contain'],
  ])('rejects %j', (input, reason) => {
    const result = normalizeVersionTag(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });
});

describe('version tags repository', () => {
  it('adds normalized tags idempotently and lists them sorted', () => {
    const { db, repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    const v1 = commitTestSnapshot(repos, deck, version(1));

    expect(repos.tags.add(v1.id, '  Tournament ')).toBe('tournament');
    expect(repos.tags.add(v1.id, 'TOURNAMENT')).toBe('tournament');
    expect(repos.tags.add(v1.id, 'Stable')).toBe('stable');
    expect(repos.tags.add(v1.id, 'budget')).toBe('budget');

    expect(repos.tags.listForCommit(v1.id)).toEqual(['budget', 'stable', 'tournament']);
    expect(countRows(db, 'version_tags')).toBe(3);
    expect(repos.tags.listForCommit('missing')).toEqual([]);
  });

  it('rejects invalid tags and unknown commits', () => {
    const { repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    const v1 = commitTestSnapshot(repos, deck, version(1));

    expect(expectRepositoryError(() => repos.tags.add(v1.id, '  '), 'invalid-input').message).toBe(
      'Tag must not be empty.',
    );
    expectRepositoryError(() => repos.tags.add(v1.id, 'a/b'), 'invalid-input');
    expectRepositoryError(() => repos.tags.add('missing', 'stable'), 'not-found');
  });

  it('removes tags given in any spelling', () => {
    const { repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    const v1 = commitTestSnapshot(repos, deck, version(1));
    repos.tags.add(v1.id, 'top 8');

    expect(repos.tags.remove(v1.id, ' TOP   8 ')).toBe(true);
    expect(repos.tags.remove(v1.id, 'top 8')).toBe(false);
    expect(repos.tags.remove(v1.id, '')).toBe(false);
    expect(repos.tags.listForCommit(v1.id)).toEqual([]);
  });

  it('lists tags for many commits, including untagged ones', () => {
    const { repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    const [v1, v2, v3] = [1, 2, 3].map((n) => commitTestSnapshot(repos, deck, version(n)));
    if (!v1 || !v2 || !v3) throw new Error('commits missing');
    repos.tags.add(v1.id, 'stable');
    repos.tags.add(v1.id, 'budget');
    repos.tags.add(v3.id, 'tournament');

    const tags = repos.tags.listForCommits([v1.id, v2.id, v3.id, v1.id]);

    expect([...tags.entries()]).toEqual([
      [v1.id, ['budget', 'stable']],
      [v2.id, []],
      [v3.id, ['tournament']],
    ]);
    expect(repos.tags.listForCommits([]).size).toBe(0);
  });

  it('counts tag usage per deck', () => {
    const { repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    const other = createTestDeck(repos);
    const [v1, v2, v3] = [1, 2, 3].map((n) => commitTestSnapshot(repos, deck, version(n)));
    if (!v1 || !v2 || !v3) throw new Error('commits missing');
    const foreign = commitTestSnapshot(repos, other, version(1));
    repos.tags.add(v1.id, 'stable');
    repos.tags.add(v3.id, 'stable');
    repos.tags.add(v2.id, 'tournament');
    repos.tags.add(v3.id, 'budget');
    repos.tags.add(foreign.id, 'stable');
    repos.tags.add(foreign.id, 'casual');

    expect(repos.tags.listForDeck(deck.id)).toEqual([
      { name: 'budget', count: 1 },
      { name: 'stable', count: 2 },
      { name: 'tournament', count: 1 },
    ]);
    expect(repos.tags.listForDeck(createTestDeck(repos).id)).toEqual([]);
  });

  it('finds the versions carrying a tag, newest first', () => {
    const { repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    const other = createTestDeck(repos);
    const [v1, v2, v3] = [1, 2, 3].map((n) => commitTestSnapshot(repos, deck, version(n)));
    if (!v1 || !v2 || !v3) throw new Error('commits missing');
    repos.tags.add(v1.id, 'stable');
    repos.tags.add(v3.id, 'stable');
    repos.tags.add(commitTestSnapshot(repos, other, version(1)).id, 'stable');

    expect(repos.tags.commitsWithTag(deck.id, ' STABLE ')).toEqual([v3, v1]);
    expect(repos.tags.commitsWithTag(deck.id, 'tournament')).toEqual([]);
    expect(repos.tags.commitsWithTag(deck.id, '!!')).toEqual([]);
  });
});
