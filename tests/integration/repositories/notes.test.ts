import { describe, expect, it } from 'vitest';

import { baseDeckSpec, buildSnapshot } from '@tests/support/builders';
import {
  commitTestSnapshot,
  createTestDeck,
  createTestRepositories,
  expectRepositoryError,
} from '@tests/support/db';

function setup(): ReturnType<typeof createTestRepositories> & { commitId: string } {
  const test = createTestRepositories();
  const deck = createTestDeck(test.repos);
  const commit = commitTestSnapshot(test.repos, deck, buildSnapshot(baseDeckSpec()));
  return { ...test, commitId: commit.id };
}

describe('commit notes repository', () => {
  it('creates a note on first upsert', () => {
    const { repos, commitId } = setup();

    const note = repos.notes.upsert(commitId, 'text', { text: 'Won FNM 4-0' });

    expect(note).toEqual({
      id: expect.any(String) as string,
      commitId,
      kind: 'text',
      data: { text: 'Won FNM 4-0' },
      createdAt: expect.any(String) as string,
      updatedAt: note.createdAt,
    });
    expect(repos.notes.get(commitId, 'text')).toEqual(note);
  });

  it('replaces the data on later upserts, keeping id and createdAt', () => {
    const { repos, commitId } = setup();
    const created = repos.notes.upsert(commitId, 'text', { text: 'first' });

    const updated = repos.notes.upsert(commitId, 'text', { text: 'second', edited: true });

    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt > created.updatedAt).toBe(true);
    expect(updated.data).toEqual({ text: 'second', edited: true });
    expect(repos.notes.listForCommit(commitId)).toEqual([updated]);
  });

  it('keeps one note per kind, listed by kind', () => {
    const { repos, commitId } = setup();
    const result = repos.notes.upsert(commitId, 'tournament-result', { placement: 3, players: 64 });
    const text = repos.notes.upsert(commitId, 'text', 'Plain string payload');
    const games = repos.notes.upsert(commitId, 'games.v1', [{ won: true }, { won: false }]);

    expect(repos.notes.listForCommit(commitId)).toEqual([games, text, result]);
    expect(repos.notes.listForCommit('missing')).toEqual([]);
    expect(repos.notes.get(commitId, 'missing-kind')).toBeNull();
  });

  it('deletes notes', () => {
    const { repos, commitId } = setup();
    repos.notes.upsert(commitId, 'text', { text: 'temporary' });

    expect(repos.notes.delete(commitId, 'text')).toBe(true);
    expect(repos.notes.delete(commitId, 'text')).toBe(false);
    expect(repos.notes.get(commitId, 'text')).toBeNull();
  });

  it('validates kind, data and the commit reference', () => {
    const { repos, commitId } = setup();
    for (const kind of ['', 'Text', '1text', 'text note', 'x'.repeat(65)]) {
      expectRepositoryError(() => repos.notes.upsert(commitId, kind, {}), 'invalid-input');
    }
    expectRepositoryError(() => repos.notes.upsert(commitId, 'text', undefined), 'invalid-input');
    expectRepositoryError(() => repos.notes.upsert(commitId, 'text', { n: Number.NaN }), 'invalid-input');
    expectRepositoryError(() => repos.notes.upsert('missing', 'text', {}), 'not-found');
    expect(repos.notes.listForCommit(commitId)).toEqual([]);
  });
});
