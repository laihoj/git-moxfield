import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { commitId } from '@/core/hash';
import type { CanonicalSnapshot } from '@/core/model';
import { commits } from '@/server/db/schema';
import type { CommitRecord, DeckRecord, Repositories } from '@/server/repositories';
import { baseDeckSpec, buildSnapshot } from '@tests/support/builders';
import {
  commitTestSnapshot,
  countRows,
  createTestDeck,
  createTestRepositories,
  expectRepositoryError,
  testSourceMetadata,
} from '@tests/support/db';

function version(n: number): CanonicalSnapshot {
  return buildSnapshot({ ...baseDeckSpec(), primer: `Version ${n} primer.\n` });
}

/** A valid, not yet inserted commit record (first version of the deck unless overridden). */
function draftCommit(
  repos: Repositories,
  deck: DeckRecord,
  overrides: Partial<Omit<CommitRecord, 'id'>> = {},
): CommitRecord {
  const branch = repos.branches.getMain(deck.id);
  if (!branch) throw new Error('main branch missing');
  const fields: Omit<CommitRecord, 'id'> = {
    deckId: deck.id,
    branchId: branch.id,
    sequence: 1,
    parentId: null,
    snapshotHash: repos.snapshots.put(version(1)),
    rawBlobHash: repos.rawBlobs.put({ mediaType: 'application/json', data: { raw: 1 } }),
    message: 'First version\n\nWith a body.',
    createdAt: '2026-05-01T10:00:00.000Z',
    ingestMethod: 'manual-paste',
    fetchedAt: '2026-05-01T09:59:00.000Z',
    sourceVersion: 12,
    sourceUpdatedAt: '2026-05-01T09:00:00.000Z',
    sourceMetadata: testSourceMetadata(deck, { version: 12, lastUpdatedAt: '2026-05-01T09:00:00.000Z' }),
    ...overrides,
  };
  const id = commitId({
    deck: `${deck.source}:${deck.externalId}`,
    snapshotHash: fields.snapshotHash,
    parentId: fields.parentId,
    createdAt: fields.createdAt,
    sourceVersion: fields.sourceVersion,
    message: fields.message,
  });
  return { id, ...fields };
}

describe('commits repository', () => {
  it('inserts a commit and reads it back by id and by sequence', () => {
    const { repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    const draft = draftCommit(repos, deck);

    expect(repos.commits.insert(draft)).toEqual(draft);

    expect(repos.commits.getById(draft.id)).toEqual(draft);
    expect(repos.commits.getBySequence(deck.id, 1)).toEqual(draft);
    expect(repos.commits.getBySequence(deck.id, 2)).toBeNull();
    expect(repos.commits.getById('missing')).toBeNull();
  });

  it('does not move the branch head on insert', () => {
    const { repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    repos.commits.insert(draftCommit(repos, deck));
    expect(repos.commits.head(deck.id)).toBeNull();
  });

  it('verifies that the id is the hash of the commit content', () => {
    const { db, repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    const draft = draftCommit(repos, deck);

    expectRepositoryError(() => repos.commits.insert({ ...draft, id: 'f'.repeat(64) }), 'invalid-input');
    expectRepositoryError(() => repos.commits.insert({ ...draft, message: 'Tampered' }), 'invalid-input');
    expectRepositoryError(() => repos.commits.insert({ ...draft, sourceVersion: 13 }), 'invalid-input');
    // Headers of the commit object must be single-line.
    expectRepositoryError(
      () => repos.commits.insert({ ...draft, createdAt: '2026-05-01\n10:00' }),
      'invalid-input',
    );
    expect(countRows(db, 'commits')).toBe(0);
  });

  it('rejects duplicate ids and sequences', () => {
    const { repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    const first = repos.commits.insert(draftCommit(repos, deck));

    expectRepositoryError(() => repos.commits.insert(first), 'conflict');
    // Sequence and branch are not part of the content: same content, same id.
    expectRepositoryError(() => repos.commits.insert(draftCommit(repos, deck, { sequence: 5 })), 'conflict');
    expectRepositoryError(
      () => repos.commits.insert(draftCommit(repos, deck, { message: 'Another root at v1' })),
      'conflict',
    );
  });

  it('validates sequence, branch, parent and content references', () => {
    const { repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    const other = createTestDeck(repos);
    const v1 = repos.commits.insert(draftCommit(repos, deck));
    const foreign = commitTestSnapshot(repos, other, version(1));
    const otherBranch = repos.branches.getMain(other.id);
    if (!otherBranch) throw new Error('main branch missing');

    expectRepositoryError(
      () => repos.commits.insert(draftCommit(repos, deck, { sequence: 0 })),
      'invalid-input',
    );
    expectRepositoryError(
      () => repos.commits.insert(draftCommit(repos, deck, { sequence: 1.5 })),
      'invalid-input',
    );
    expectRepositoryError(
      () =>
        repos.commits.insert(
          draftCommit(repos, deck, { sequence: 2, parentId: v1.id, branchId: otherBranch.id }),
        ),
      'not-found',
    );
    expectRepositoryError(
      () => repos.commits.insert(draftCommit(repos, deck, { sequence: 2, parentId: foreign.id })),
      'not-found',
    );
    expectRepositoryError(
      () => repos.commits.insert(draftCommit(repos, deck, { sequence: 2, parentId: 'missing' })),
      'not-found',
    );
    expectRepositoryError(
      () =>
        repos.commits.insert({
          ...draftCommit(repos, deck, { sequence: 2, parentId: v1.id }),
          deckId: 'missing',
        }),
      'not-found',
    );
    expectRepositoryError(
      () =>
        repos.commits.insert(
          draftCommit(repos, deck, { sequence: 2, parentId: v1.id, snapshotHash: 'a'.repeat(64) }),
        ),
      'not-found',
    );
    expectRepositoryError(
      () =>
        repos.commits.insert(
          draftCommit(repos, deck, { sequence: 2, parentId: v1.id, rawBlobHash: 'b'.repeat(64) }),
        ),
      'not-found',
    );
    expect(repos.commits.count(deck.id)).toBe(1);

    const v3 = repos.commits.insert(
      draftCommit(repos, deck, { sequence: 3, parentId: v1.id, rawBlobHash: null }),
    );
    expectRepositoryError(
      () =>
        repos.commits.insert(
          draftCommit(repos, deck, { sequence: 2, parentId: v3.id, message: 'Back in time' }),
        ),
      'invalid-input',
    );
  });

  it('resolves HEAD through the deck head branch', () => {
    const { repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    expect(repos.commits.head(deck.id)).toBeNull();
    commitTestSnapshot(repos, deck, version(1));
    const v2 = commitTestSnapshot(repos, deck, version(2));
    expect(repos.commits.head(deck.id)).toEqual(v2);
    expect(repos.commits.head('missing')).toBeNull();
  });

  it('walks the lineage from HEAD or a given commit, oldest first', () => {
    const { repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    const other = createTestDeck(repos);
    const v1 = commitTestSnapshot(repos, deck, version(1));
    const v2 = commitTestSnapshot(repos, deck, version(2));
    const v3 = commitTestSnapshot(repos, deck, version(3));
    // A version off the main line (an experiment): parent v1, HEAD stays at v3.
    const side = commitTestSnapshot(repos, deck, version(4), { parentId: v1.id, moveHead: false });
    commitTestSnapshot(repos, other, version(1));

    expect(repos.commits.lineage(deck.id).map((c) => c.sequence)).toEqual([1, 2, 3]);
    expect(repos.commits.lineage(deck.id)).toEqual([v1, v2, v3]);
    expect(repos.commits.lineage(deck.id, v2.id).map((c) => c.id)).toEqual([v1.id, v2.id]);
    expect(repos.commits.lineage(deck.id, side.id).map((c) => c.id)).toEqual([v1.id, side.id]);
    expect(repos.commits.lineage(deck.id, 'missing')).toEqual([]);
    expect(repos.commits.lineage(other.id, v2.id)).toEqual([]);
    expect(repos.commits.lineage(createTestDeck(repos).id)).toEqual([]);
  });

  it('lists, counts and finds the highest sequence per deck', () => {
    const { repos } = createTestRepositories();
    const deck = createTestDeck(repos);
    const other = createTestDeck(repos);
    expect(repos.commits.listForDeck(deck.id)).toEqual([]);
    expect(repos.commits.count(deck.id)).toBe(0);
    expect(repos.commits.maxSequence(deck.id)).toBeNull();

    const versions = [1, 2, 3].map((n) => commitTestSnapshot(repos, deck, version(n)));
    commitTestSnapshot(repos, other, version(1));

    expect(repos.commits.listForDeck(deck.id)).toEqual([...versions].reverse());
    expect(repos.commits.count(deck.id)).toBe(3);
    expect(repos.commits.maxSequence(deck.id)).toBe(3);
    expect(repos.commits.maxSequence(other.id)).toBe(1);
  });

  describe('findByIdPrefix', () => {
    it('resolves unique prefixes case-insensitively within the deck', () => {
      const { repos } = createTestRepositories();
      const deck = createTestDeck(repos);
      const other = createTestDeck(repos);
      const v1 = commitTestSnapshot(repos, deck, version(1));
      const foreign = commitTestSnapshot(repos, other, version(2));

      expect(repos.commits.findByIdPrefix(deck.id, v1.id)).toEqual(v1);
      expect(repos.commits.findByIdPrefix(deck.id, v1.id.slice(0, 7))).toEqual(v1);
      expect(repos.commits.findByIdPrefix(deck.id, ` ${v1.id.slice(0, 4).toUpperCase()} `)).toEqual(v1);
      expect(repos.commits.findByIdPrefix(deck.id, foreign.id.slice(0, 12))).toBeNull();
    });

    it('rejects prefixes that are too short or not hex', () => {
      const { repos } = createTestRepositories();
      const deck = createTestDeck(repos);
      const v1 = commitTestSnapshot(repos, deck, version(1));

      expect(repos.commits.findByIdPrefix(deck.id, v1.id.slice(0, 3))).toBeNull();
      expect(repos.commits.findByIdPrefix(deck.id, '')).toBeNull();
      expect(repos.commits.findByIdPrefix(deck.id, `${v1.id.slice(0, 6)}%`)).toBeNull();
      expect(repos.commits.findByIdPrefix(deck.id, 'v1')).toBeNull();
      expect(repos.commits.findByIdPrefix(deck.id, `${v1.id}0`)).toBeNull();
    });

    it('returns null for ambiguous prefixes', () => {
      const { repos } = createTestRepositories();
      const deck = createTestDeck(repos);
      const snapshotHash = repos.snapshots.put(version(1));
      const createdAt = '2026-06-01T00:00:00.000Z';
      const idFor = (message: string): string =>
        commitId({
          deck: `${deck.source}:${deck.externalId}`,
          snapshotHash,
          parentId: null,
          createdAt,
          sourceVersion: null,
          message,
        });
      // Find two root commits whose ids share their first four hex digits.
      const seen = new Map<string, string>();
      let pair: [string, string] | undefined;
      for (let i = 0; !pair; i++) {
        const message = `Attempt ${i}`;
        const prefix = idFor(message).slice(0, 4);
        const earlier = seen.get(prefix);
        if (earlier === undefined) seen.set(prefix, message);
        else pair = [earlier, message];
      }
      const [a, b] = pair.map((message) =>
        commitTestSnapshot(repos, deck, version(1), {
          message,
          createdAt,
          parentId: null,
          sourceVersion: null,
        }),
      );
      if (!a || !b) throw new Error('commits missing');
      const shared = a.id.slice(0, 4);
      expect(b.id.startsWith(shared)).toBe(true);

      expect(repos.commits.findByIdPrefix(deck.id, shared)).toBeNull();
      const longer = (id: string): string => {
        let length = 5;
        while (a.id.slice(0, length) === b.id.slice(0, length)) length++;
        return id.slice(0, length);
      };
      expect(repos.commits.findByIdPrefix(deck.id, longer(a.id))).toEqual(a);
      expect(repos.commits.findByIdPrefix(deck.id, longer(b.id))).toEqual(b);
    });
  });

  describe('immutability', () => {
    it('rejects updates of commits, even through raw SQL', () => {
      const { db, repos } = createTestRepositories();
      const deck = createTestDeck(repos);
      const v1 = commitTestSnapshot(repos, deck, version(1));

      expect(() =>
        db.$client.prepare("UPDATE commits SET message = 'rewritten' WHERE id = ?").run(v1.id),
      ).toThrow(/commits are immutable/);
      expect(() => db.update(commits).set({ sequence: 99 }).where(eq(commits.id, v1.id)).run()).toThrow(
        /commits are immutable/,
      );
      expect(repos.commits.getById(v1.id)).toEqual(v1);
    });

    it('rejects deleting commits while their deck exists', () => {
      const { db, repos } = createTestRepositories();
      const deck = createTestDeck(repos);
      const v1 = commitTestSnapshot(repos, deck, version(1));

      expect(() => db.$client.prepare('DELETE FROM commits WHERE id = ?').run(v1.id)).toThrow(
        /delete the deck to remove its history/,
      );
      expect(() => db.delete(commits).run()).toThrow(/commits are immutable/);
      expect(repos.commits.getById(v1.id)).toEqual(v1);

      expect(repos.decks.delete(deck.id)).toBe(true);
      expect(countRows(db, 'commits')).toBe(0);
    });
  });
});
