/**
 * Version tags: short, reusable, mutable labels on versions (`tournament`, `stable`,
 * `pre-ban`). A version can carry many tags and a tag many versions.
 */
import { and, count, desc, eq, getTableColumns, inArray } from 'drizzle-orm';

import { compareStrings } from '@/core/canonical';
import { commits, versionTags } from '@/server/db/schema';

import { toCommitRecord, type CommitRecord } from './commits';
import { batches, distinct, referencing, type RepositoryContext } from './context';
import { RepositoryError } from './errors';

/** Maximum tag length in Unicode code points (after normalization). */
export const MAX_VERSION_TAG_LENGTH = 40;

export type VersionTagValidation = { ok: true; name: string } | { ok: false; reason: string };

const ALLOWED_TAG = /^[\p{L}\p{M}\p{N} ._-]+$/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * Normalizes user input into a tag name: lowercase, NFC, runs of whitespace collapsed
 * to one space, trimmed. A valid tag has 1–{@link MAX_VERSION_TAG_LENGTH} characters
 * from: letters and digits of any script (with combining marks), space, `.`, `-` and
 * `_`, and at least one letter or digit. Invalid input is rejected rather than
 * silently altered, so the user sees exactly the tag that is stored.
 */
export function normalizeVersionTag(input: string): VersionTagValidation {
  const name = input.toLowerCase().normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (name === '') return { ok: false, reason: 'Tag must not be empty.' };
  if (codePointLength(name) > MAX_VERSION_TAG_LENGTH) {
    return { ok: false, reason: `Tags can be at most ${MAX_VERSION_TAG_LENGTH} characters long.` };
  }
  if (!ALLOWED_TAG.test(name) || !HAS_LETTER_OR_DIGIT.test(name)) {
    return { ok: false, reason: 'Tags may contain letters, digits, spaces, ".", "-" and "_".' };
  }
  return { ok: true, name };
}

function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length++;
  return length;
}

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
  add(commitId: string, tag: string): string;
  /** Removes a tag (input is normalized first). Returns whether it was present. */
  remove(commitId: string, tag: string): boolean;
  /** Tags of one version, sorted. */
  listForCommit(commitId: string): string[];
  /** Tags of several versions; every requested id is present (possibly with `[]`). */
  listForCommits(commitIds: Iterable<string>): Map<string, string[]>;
  /** Every tag used in the deck with the number of versions carrying it, sorted by name. */
  listForDeck(deckId: string): TagCount[];
  /** Versions of the deck carrying the tag, newest first. Invalid tags match nothing. */
  commitsWithTag(deckId: string, tag: string): CommitRecord[];
}

export function createVersionTagRepository(ctx: RepositoryContext): VersionTagRepository {
  return {
    add(commitId, tag) {
      const validation = normalizeVersionTag(tag);
      if (!validation.ok) throw new RepositoryError('invalid-input', validation.reason);
      const { name } = validation;
      referencing(`Tag ${name}`, () =>
        ctx.db
          .insert(versionTags)
          .values({ commitId, name, createdAt: ctx.now() })
          .onConflictDoNothing()
          .run(),
      );
      return name;
    },

    remove(commitId, tag) {
      const validation = normalizeVersionTag(tag);
      if (!validation.ok) return false;
      const result = ctx.db
        .delete(versionTags)
        .where(and(eq(versionTags.commitId, commitId), eq(versionTags.name, validation.name)))
        .run();
      return result.changes > 0;
    },

    listForCommit(commitId) {
      return ctx.db
        .select({ name: versionTags.name })
        .from(versionTags)
        .where(eq(versionTags.commitId, commitId))
        .all()
        .map((row) => row.name)
        .sort(compareStrings);
    },

    listForCommits(commitIds) {
      const ids = distinct(commitIds);
      const result = new Map<string, string[]>(ids.map((id) => [id, []]));
      for (const batch of batches(ids)) {
        const rows = ctx.db
          .select({ commitId: versionTags.commitId, name: versionTags.name })
          .from(versionTags)
          .where(inArray(versionTags.commitId, batch))
          .all();
        for (const row of rows) result.get(row.commitId)?.push(row.name);
      }
      for (const names of result.values()) names.sort(compareStrings);
      return result;
    },

    listForDeck(deckId) {
      return ctx.db
        .select({ name: versionTags.name, count: count() })
        .from(versionTags)
        .innerJoin(commits, eq(commits.id, versionTags.commitId))
        .where(eq(commits.deckId, deckId))
        .groupBy(versionTags.name)
        .all()
        .sort((a, b) => compareStrings(a.name, b.name));
    },

    commitsWithTag(deckId, tag) {
      const validation = normalizeVersionTag(tag);
      if (!validation.ok) return [];
      return ctx.db
        .select(getTableColumns(commits))
        .from(commits)
        .innerJoin(versionTags, eq(versionTags.commitId, commits.id))
        .where(and(eq(commits.deckId, deckId), eq(versionTags.name, validation.name)))
        .orderBy(desc(commits.sequence))
        .all()
        .map(toCommitRecord);
    },
  };
}
