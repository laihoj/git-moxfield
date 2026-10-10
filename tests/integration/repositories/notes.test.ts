import { describe, expect, it } from 'vitest';

import { MAX_STORED_VALUE_BYTES } from '@/server/repositories';
import { baseDeckSpec, buildSnapshot } from '@tests/support/builders';
import {
  commitTestSnapshot,
  createTestDeck,
  createTestRepositories,
  expectRepositoryError,
  type TestDb,
} from '@tests/support/db';

async function setup(): Promise<TestDb & { commitId: string }> {
  const test = await createTestRepositories();
  const deck = await createTestDeck(test.repos);
  const commit = await commitTestSnapshot(test.repos, deck, buildSnapshot(baseDeckSpec()));
  return { ...test, commitId: commit.id };
}

describe('commit notes repository', () => {
  it('creates a note on first upsert', async () => {
    const { repos, commitId } = await setup();

    const note = await repos.notes.upsert(commitId, 'text', { text: 'Won FNM 4-0' });

    expect(note).toEqual({
      id: expect.any(String) as string,
      commitId,
      kind: 'text',
      data: { text: 'Won FNM 4-0' },
      createdAt: expect.any(String) as string,
      updatedAt: note.createdAt,
    });
    expect(await repos.notes.get(commitId, 'text')).toEqual(note);
  });

  it('replaces the data on later upserts, keeping id and createdAt', async () => {
    const { repos, commitId } = await setup();
    const created = await repos.notes.upsert(commitId, 'text', { text: 'first' });

    const updated = await repos.notes.upsert(commitId, 'text', { text: 'second', edited: true });

    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt > created.updatedAt).toBe(true);
    expect(updated.data).toEqual({ text: 'second', edited: true });
    expect(await repos.notes.listForCommit(commitId)).toEqual([updated]);
  });

  it('keeps one note per kind, listed by kind', async () => {
    const { repos, commitId } = await setup();
    const result = await repos.notes.upsert(commitId, 'tournament-result', { placement: 3, players: 64 });
    const text = await repos.notes.upsert(commitId, 'text', 'Plain string payload');
    const games = await repos.notes.upsert(commitId, 'games.v1', [{ won: true }, { won: false }]);

    expect(await repos.notes.listForCommit(commitId)).toEqual([games, text, result]);
    expect(await repos.notes.listForCommit('missing')).toEqual([]);
    expect(await repos.notes.get(commitId, 'missing-kind')).toBeNull();
  });

  it('deletes notes', async () => {
    const { repos, commitId } = await setup();
    await repos.notes.upsert(commitId, 'text', { text: 'temporary' });

    expect(await repos.notes.delete(commitId, 'text')).toBe(true);
    expect(await repos.notes.delete(commitId, 'text')).toBe(false);
    expect(await repos.notes.get(commitId, 'text')).toBeNull();
  });

  it('validates kind, data and the commit reference', async () => {
    const { repos, commitId } = await setup();
    for (const kind of ['', 'Text', '1text', 'text note', 'x'.repeat(65)]) {
      await expectRepositoryError(() => repos.notes.upsert(commitId, kind, {}), 'invalid-input');
    }
    await expectRepositoryError(() => repos.notes.upsert(commitId, 'text', undefined), 'invalid-input');
    await expectRepositoryError(
      () => repos.notes.upsert(commitId, 'text', { n: Number.NaN }),
      'invalid-input',
    );
    await expectRepositoryError(() => repos.notes.upsert('missing', 'text', {}), 'not-found');
    expect(await repos.notes.listForCommit(commitId)).toEqual([]);
  });

  it('refuses note data too large to store', async () => {
    const { repos, commitId } = await setup();
    await expectRepositoryError(
      repos.notes.upsert(commitId, 'text', { text: 'x'.repeat(MAX_STORED_VALUE_BYTES) }),
      'invalid-input',
    );
    expect(await repos.notes.listForCommit(commitId)).toEqual([]);
  });
});
