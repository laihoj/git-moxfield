import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { commitId } from '@/core/hash';
import type { CanonicalSnapshot } from '@/core/model';
import { commits } from '@/server/db/schema';
import {
  createRepositories,
  type CommitRecord,
  type DeckRecord,
  type Repositories,
} from '@/server/repositories';
import { baseDeckSpec, buildSnapshot } from '@tests/support/builders';
import {
  commitTestSnapshot,
  commitTestSnapshots,
  countRows,
  createTestDeck,
  createTestRepositories,
  expectDatabaseError,
  expectRepositoryError,
  testSourceMetadata,
} from '@tests/support/db';

function version(n: number): CanonicalSnapshot {
  return buildSnapshot({ ...baseDeckSpec(), primer: `Version ${n} primer.\n` });
}

/** A valid, not yet inserted commit record (first version of the deck unless overridden). */
async function draftCommit(
  repos: Repositories,
  deck: DeckRecord,
  overrides: Partial<Omit<CommitRecord, 'id'>> = {},
): Promise<CommitRecord> {
  const branch = await repos.branches.getMain(deck.id);
  if (!branch) throw new Error('main branch missing');
  const fields: Omit<CommitRecord, 'id'> = {
    deckId: deck.id,
    branchId: branch.id,
    sequence: 1,
    parentId: null,
    snapshotHash: await repos.snapshots.put(version(1)),
    rawBlobHash: await repos.rawBlobs.put({ mediaType: 'application/json', data: { raw: 1 } }),
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
  it('inserts a commit and reads it back by id and by sequence', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const draft = await draftCommit(repos, deck);

    expect(await repos.commits.insert(draft)).toEqual(draft);

    expect(await repos.commits.getById(draft.id)).toEqual(draft);
    expect(await repos.commits.getBySequence(deck.id, 1)).toEqual(draft);
    expect(await repos.commits.getBySequence(deck.id, 2)).toBeNull();
    expect(await repos.commits.getById('missing')).toBeNull();
  });

  it('does not move the branch head on insert', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    await repos.commits.insert(await draftCommit(repos, deck));
    expect(await repos.commits.head(deck.id)).toBeNull();
  });

  it('verifies that the id is the hash of the commit content', async () => {
    const { db, repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const draft = await draftCommit(repos, deck);

    await expectRepositoryError(
      () => repos.commits.insert({ ...draft, id: 'f'.repeat(64) }),
      'invalid-input',
    );
    await expectRepositoryError(
      () => repos.commits.insert({ ...draft, message: 'Tampered' }),
      'invalid-input',
    );
    await expectRepositoryError(() => repos.commits.insert({ ...draft, sourceVersion: 13 }), 'invalid-input');
    // Headers of the commit object must be single-line.
    await expectRepositoryError(
      () => repos.commits.insert({ ...draft, createdAt: '2026-05-01\n10:00' }),
      'invalid-input',
    );
    expect(await countRows(db, 'commits')).toBe(0);
  });

  it('rejects duplicate ids and sequences', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const first = await repos.commits.insert(await draftCommit(repos, deck));

    await expectRepositoryError(() => repos.commits.insert(first), 'conflict');
    // Sequence and branch are not part of the content: same content, same id.
    await expectRepositoryError(
      async () => repos.commits.insert(await draftCommit(repos, deck, { sequence: 5 })),
      'conflict',
    );
    await expectRepositoryError(
      async () => repos.commits.insert(await draftCommit(repos, deck, { message: 'Another root at v1' })),
      'conflict',
    );
  });

  it('validates sequence, branch, parent and content references', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const other = await createTestDeck(repos);
    const v1 = await repos.commits.insert(await draftCommit(repos, deck));
    const foreign = await commitTestSnapshot(repos, other, version(1));
    const otherBranch = await repos.branches.getMain(other.id);
    if (!otherBranch) throw new Error('main branch missing');

    await expectRepositoryError(
      async () => repos.commits.insert(await draftCommit(repos, deck, { sequence: 0 })),
      'invalid-input',
    );
    await expectRepositoryError(
      async () => repos.commits.insert(await draftCommit(repos, deck, { sequence: 1.5 })),
      'invalid-input',
    );
    await expectRepositoryError(
      async () =>
        repos.commits.insert(
          await draftCommit(repos, deck, { sequence: 2, parentId: v1.id, branchId: otherBranch.id }),
        ),
      'not-found',
    );
    await expectRepositoryError(
      async () => repos.commits.insert(await draftCommit(repos, deck, { sequence: 2, parentId: foreign.id })),
      'not-found',
    );
    await expectRepositoryError(
      async () => repos.commits.insert(await draftCommit(repos, deck, { sequence: 2, parentId: 'missing' })),
      'not-found',
    );
    await expectRepositoryError(
      async () =>
        repos.commits.insert({
          ...(await draftCommit(repos, deck, { sequence: 2, parentId: v1.id })),
          deckId: 'missing',
        }),
      'not-found',
    );
    await expectRepositoryError(
      async () =>
        repos.commits.insert(
          await draftCommit(repos, deck, { sequence: 2, parentId: v1.id, snapshotHash: 'a'.repeat(64) }),
        ),
      'not-found',
    );
    await expectRepositoryError(
      async () =>
        repos.commits.insert(
          await draftCommit(repos, deck, { sequence: 2, parentId: v1.id, rawBlobHash: 'b'.repeat(64) }),
        ),
      'not-found',
    );
    expect(await repos.commits.count(deck.id)).toBe(1);

    const v3 = await repos.commits.insert(
      await draftCommit(repos, deck, { sequence: 3, parentId: v1.id, rawBlobHash: null }),
    );
    await expectRepositoryError(
      async () =>
        repos.commits.insert(
          await draftCommit(repos, deck, { sequence: 2, parentId: v3.id, message: 'Back in time' }),
        ),
      'invalid-input',
    );
  });

  it('resolves HEAD through the deck head branch', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    expect(await repos.commits.head(deck.id)).toBeNull();
    await commitTestSnapshot(repos, deck, version(1));
    const v2 = await commitTestSnapshot(repos, deck, version(2));
    expect(await repos.commits.head(deck.id)).toEqual(v2);
    expect(await repos.commits.head('missing')).toBeNull();
  });

  it('reads HEAD together with its snapshot', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    expect(await repos.commits.headWithSnapshot(deck.id)).toBeNull();
    await commitTestSnapshot(repos, deck, version(1));
    const v2 = await commitTestSnapshot(repos, deck, version(2));
    // A version off the main line does not move HEAD.
    await commitTestSnapshot(repos, deck, version(3), { moveHead: false });
    expect(await repos.commits.headWithSnapshot(deck.id)).toEqual({ commit: v2, snapshot: version(2) });
    expect(await repos.commits.headWithSnapshot('missing')).toBeNull();
  });

  it('walks the lineage from HEAD or a given commit, oldest first', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const other = await createTestDeck(repos);
    const v1 = await commitTestSnapshot(repos, deck, version(1));
    const v2 = await commitTestSnapshot(repos, deck, version(2));
    const v3 = await commitTestSnapshot(repos, deck, version(3));
    // A version off the main line (an experiment): parent v1, HEAD stays at v3.
    const side = await commitTestSnapshot(repos, deck, version(4), { parentId: v1.id, moveHead: false });
    await commitTestSnapshot(repos, other, version(1));

    expect((await repos.commits.lineage(deck.id)).map((c) => c.sequence)).toEqual([1, 2, 3]);
    expect(await repos.commits.lineage(deck.id)).toEqual([v1, v2, v3]);
    expect((await repos.commits.lineage(deck.id, v2.id)).map((c) => c.id)).toEqual([v1.id, v2.id]);
    expect((await repos.commits.lineage(deck.id, side.id)).map((c) => c.id)).toEqual([v1.id, side.id]);
    expect(await repos.commits.lineage(deck.id, 'missing')).toEqual([]);
    expect(await repos.commits.lineage(other.id, v2.id)).toEqual([]);
    expect(await repos.commits.lineage((await createTestDeck(repos)).id)).toEqual([]);
  });

  it('lists, counts and finds the highest sequence per deck', async () => {
    const { db, repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    const other = await createTestDeck(repos);
    expect(await repos.commits.listForDeck(deck.id)).toEqual([]);
    expect(await repos.commits.count(deck.id)).toBe(0);
    expect(await repos.commits.maxSequence(deck.id)).toBeNull();

    const versions = await commitTestSnapshots(repos, deck, [1, 2, 3].map(version));
    await commitTestSnapshot(repos, other, version(1));

    expect(await repos.commits.listForDeck(deck.id)).toEqual([...versions].reverse());
    expect(await repos.commits.count(deck.id)).toBe(3);
    expect(await repos.commits.maxSequence(deck.id)).toBe(3);
    expect(await repos.commits.maxSequence(other.id)).toBe(1);
    expect(await repos.commits.countByDeck()).toEqual(
      new Map([
        [deck.id, 3],
        [other.id, 1],
      ]),
    );
    // Decks without versions are absent, and other workspaces' versions are not counted.
    await createTestDeck(repos);
    const team = await repos.users.create({ displayName: 'Team', role: 'member' });
    const theirs = createRepositories(db, { workspaceId: team.workspaceId });
    await commitTestSnapshot(theirs, await createTestDeck(theirs), version(1));
    expect([...(await repos.commits.countByDeck()).keys()].sort()).toEqual([deck.id, other.id].sort());
    expect([...(await theirs.commits.countByDeck()).values()]).toEqual([1]);
  });

  describe('findByIdPrefix', () => {
    it('resolves unique prefixes case-insensitively within the deck', async () => {
      const { repos } = await createTestRepositories();
      const deck = await createTestDeck(repos);
      const other = await createTestDeck(repos);
      const v1 = await commitTestSnapshot(repos, deck, version(1));
      const foreign = await commitTestSnapshot(repos, other, version(2));

      expect(await repos.commits.findByIdPrefix(deck.id, v1.id)).toEqual(v1);
      expect(await repos.commits.findByIdPrefix(deck.id, v1.id.slice(0, 7))).toEqual(v1);
      expect(await repos.commits.findByIdPrefix(deck.id, ` ${v1.id.slice(0, 4).toUpperCase()} `)).toEqual(v1);
      expect(await repos.commits.findByIdPrefix(deck.id, foreign.id.slice(0, 12))).toBeNull();
    });

    it('rejects prefixes that are too short or not hex', async () => {
      const { repos } = await createTestRepositories();
      const deck = await createTestDeck(repos);
      const v1 = await commitTestSnapshot(repos, deck, version(1));

      expect(await repos.commits.findByIdPrefix(deck.id, v1.id.slice(0, 3))).toBeNull();
      expect(await repos.commits.findByIdPrefix(deck.id, '')).toBeNull();
      expect(await repos.commits.findByIdPrefix(deck.id, `${v1.id.slice(0, 6)}%`)).toBeNull();
      expect(await repos.commits.findByIdPrefix(deck.id, 'v1')).toBeNull();
      expect(await repos.commits.findByIdPrefix(deck.id, `${v1.id}0`)).toBeNull();
    });

    it('returns null for ambiguous prefixes', async () => {
      const { repos } = await createTestRepositories();
      const deck = await createTestDeck(repos);
      const snapshotHash = await repos.snapshots.put(version(1));
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
      const commitRoot = (message: string) =>
        commitTestSnapshot(repos, deck, version(1), {
          message,
          createdAt,
          parentId: null,
          sourceVersion: null,
        });
      const a = await commitRoot(pair[0]);
      const b = await commitRoot(pair[1]);
      const shared = a.id.slice(0, 4);
      expect(b.id.startsWith(shared)).toBe(true);

      expect(await repos.commits.findByIdPrefix(deck.id, shared)).toBeNull();
      const longer = (id: string): string => {
        let length = 5;
        while (a.id.slice(0, length) === b.id.slice(0, length)) length++;
        return id.slice(0, length);
      };
      expect(await repos.commits.findByIdPrefix(deck.id, longer(a.id))).toEqual(a);
      expect(await repos.commits.findByIdPrefix(deck.id, longer(b.id))).toEqual(b);
    });
  });

  describe('immutability', () => {
    it('rejects updates of commits, even through raw SQL', async () => {
      const { db, repos } = await createTestRepositories();
      const deck = await createTestDeck(repos);
      const v1 = await commitTestSnapshot(repos, deck, version(1));

      await expectDatabaseError(
        db.run(sql`UPDATE commits SET message = 'rewritten' WHERE id = ${v1.id}`),
        'trigger',
        /commits are immutable/,
      );
      await expectDatabaseError(
        db.update(commits).set({ sequence: 99 }).where(eq(commits.id, v1.id)),
        'trigger',
        /commits are immutable/,
      );
      expect(await repos.commits.getById(v1.id)).toEqual(v1);
    });

    it('rejects deleting commits while their deck exists', async () => {
      const { db, repos } = await createTestRepositories();
      const deck = await createTestDeck(repos);
      const v1 = await commitTestSnapshot(repos, deck, version(1));

      await expectDatabaseError(
        db.run(sql`DELETE FROM commits WHERE id = ${v1.id}`),
        'trigger',
        /delete the deck to remove its history/,
      );
      await expectDatabaseError(db.delete(commits), 'trigger', /commits are immutable/);
      expect(await repos.commits.getById(v1.id)).toEqual(v1);

      expect(await repos.decks.delete(deck.id)).toBe(true);
      expect(await countRows(db, 'commits')).toBe(0);
    });
  });
});
