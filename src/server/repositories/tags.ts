/**
 * Version tags: short, reusable, mutable labels on versions (`tournament`, `stable`,
 * `pre-ban`). A version can carry many tags and a tag many versions.
 */
import { and, count, desc, eq, getTableColumns, inArray } from 'drizzle-orm';

import { compareStrings } from '@/core/canonical';
import { normalizeVersionTag } from '@/core/tags';
import { commits, versionTags } from '@/server/db/schema';

import { toCommitRecord, type CommitRecord } from './commits';
import {
  batches,
  commitInWorkspace,
  deckInWorkspace,
  distinct,
  referencing,
  write,
  type RepositoryContext,
} from './context';
import { RepositoryError } from './errors';

export interface TagCount {
  name: string;
  /** Number of versions of the deck carrying the tag. */
  count: number;
}

export interface VersionTagRepository {
  /**
   * Tags a version (idempotent) and returns the normalized tag name.
   * @throws {RepositoryError} `invalid-input` for an invalid tag (see
   * {@link normalizeVersionTag}); `not-found` for an unknown commit.
   */
  add(commitId: string, tag: string): Promise<string>;
  /** Removes a tag (input is normalized first). Returns whether it was present. */
  remove(commitId: string, tag: string): Promise<boolean>;
  /** Tags of one version, sorted. */
  listForCommit(commitId: string): Promise<string[]>;
  /** Tags of several versions; every requested id is present (possibly with `[]`). */
  listForCommits(commitIds: Iterable<string>): Promise<Map<string, string[]>>;
  /** Every tag used in the deck with the number of versions carrying it, sorted by name. */
  listForDeck(deckId: string): Promise<TagCount[]>;
  /** Versions of the deck carrying the tag, newest first. Invalid tags match nothing. */
  commitsWithTag(deckId: string, tag: string): Promise<CommitRecord[]>;
}

export function createVersionTagRepository(ctx: RepositoryContext): VersionTagRepository {
  /** Tags of `commit` (a commit id, or the row's own commit) if it is in the context's workspace. */
  const ownedCommit = (commit: string | typeof versionTags.commitId) => commitInWorkspace(ctx, commit);

  return {
    async add(commitId, tag) {
      const validation = normalizeVersionTag(tag);
      if (!validation.ok) throw new RepositoryError('invalid-input', validation.reason);
      const { name } = validation;
      const owned = await ctx.db
        .select({ id: commits.id })
        .from(commits)
        .where(and(eq(commits.id, commitId), deckInWorkspace(ctx, commits.deckId)))
        .get();
      if (!owned) throw new RepositoryError('not-found', `Commit ${commitId} does not exist`);
      const createdAt = ctx.now();
      await referencing(`Tag ${name}`, () =>
        write(ctx, (db) =>
          db.insert(versionTags).values({ commitId, name, createdAt }).onConflictDoNothing(),
        ),
      );
      return name;
    },

    async remove(commitId, tag) {
      const validation = normalizeVersionTag(tag);
      if (!validation.ok) return false;
      const result = await write(ctx, (db) =>
        db
          .delete(versionTags)
          .where(
            and(
              eq(versionTags.commitId, commitId),
              eq(versionTags.name, validation.name),
              ownedCommit(commitId),
            ),
          ),
      );
      return result.rowsAffected > 0;
    },

    async listForCommit(commitId) {
      const rows = await ctx.db
        .select({ name: versionTags.name })
        .from(versionTags)
        .where(and(eq(versionTags.commitId, commitId), ownedCommit(commitId)))
        .all();
      return rows.map((row) => row.name).sort(compareStrings);
    },

    async listForCommits(commitIds) {
      const ids = distinct(commitIds);
      const result = new Map<string, string[]>(ids.map((id) => [id, []]));
      const pages = await Promise.all(
        batches(ids).map((batch) =>
          ctx.db
            .select({ commitId: versionTags.commitId, name: versionTags.name })
            .from(versionTags)
            .where(and(inArray(versionTags.commitId, batch), ownedCommit(versionTags.commitId)))
            .all(),
        ),
      );
      for (const row of pages.flat()) result.get(row.commitId)?.push(row.name);
      for (const names of result.values()) names.sort(compareStrings);
      return result;
    },

    async listForDeck(deckId) {
      const rows = await ctx.db
        .select({ name: versionTags.name, count: count() })
        .from(versionTags)
        .innerJoin(commits, eq(commits.id, versionTags.commitId))
        .where(and(eq(commits.deckId, deckId), deckInWorkspace(ctx, deckId)))
        .groupBy(versionTags.name)
        .all();
      return rows.sort((a, b) => compareStrings(a.name, b.name));
    },

    async commitsWithTag(deckId, tag) {
      const validation = normalizeVersionTag(tag);
      if (!validation.ok) return [];
      const rows = await ctx.db
        .select(getTableColumns(commits))
        .from(commits)
        .innerJoin(versionTags, eq(versionTags.commitId, commits.id))
        .where(
          and(
            eq(commits.deckId, deckId),
            eq(versionTags.name, validation.name),
            deckInWorkspace(ctx, deckId),
          ),
        )
        .orderBy(desc(commits.sequence))
        .all();
      return rows.map(toCommitRecord);
    },
  };
}
