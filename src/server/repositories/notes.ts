/**
 * Commit notes: mutable, structured annotations on immutable versions, in the spirit
 * of `git notes`. Each version has at most one note per `kind`; `kind` namespaces the
 * JSON payload (`note` for the free-text note today, see the services'
 * `FREE_TEXT_NOTE_KIND`; tournament results etc. later).
 */
import { and, asc, eq, inArray } from 'drizzle-orm';

import { commitNotes, commits } from '@/server/db/schema';

import { decodeJson, encodeJson } from './codec';
import { inWorkspace, referencing, type RepositoryContext } from './context';
import { RepositoryError } from './errors';

export interface CommitNoteRecord {
  id: string;
  commitId: string;
  kind: string;
  /** The note payload (any JSON value). */
  data: unknown;
  createdAt: string;
  updatedAt: string;
}

/** Note kinds: lowercase identifiers such as `note` or `tournament-result`. */
const NOTE_KIND = /^[a-z][a-z0-9._-]{0,63}$/;

export interface CommitNoteRepository {
  /**
   * Creates or replaces the note of `kind` on a version. Replacing keeps the note's id
   * and `createdAt` and moves `updatedAt`.
   * @throws {RepositoryError} `invalid-input` for an invalid kind or non-JSON data;
   * `not-found` for an unknown commit.
   */
  upsert(commitId: string, kind: string, data: unknown): CommitNoteRecord;
  get(commitId: string, kind: string): CommitNoteRecord | null;
  /** All notes of a version, sorted by kind. */
  listForCommit(commitId: string): CommitNoteRecord[];
  /** Returns whether a note was deleted. */
  delete(commitId: string, kind: string): boolean;
}

export function createCommitNoteRepository(ctx: RepositoryContext): CommitNoteRepository {
  /** Notes of commits of decks in the context's workspace. */
  const owned = () =>
    inArray(
      commitNotes.commitId,
      ctx.db.select({ id: commits.id }).from(commits).where(inWorkspace(ctx, commits.deckId)),
    );

  return {
    upsert(commitId, kind, data) {
      if (!NOTE_KIND.test(kind)) {
        throw new RepositoryError('invalid-input', `Invalid note kind ${JSON.stringify(kind)}`);
      }
      const commit = ctx.db
        .select({ id: commits.id })
        .from(commits)
        .where(and(eq(commits.id, commitId), inWorkspace(ctx, commits.deckId)))
        .get();
      if (!commit) throw new RepositoryError('not-found', `Commit ${commitId} does not exist`);
      const dataJson = encodeJson(data, 'Note data');
      const now = ctx.now();
      const row = referencing(`Note ${kind}`, () =>
        ctx.db
          .insert(commitNotes)
          .values({ id: ctx.newId(), commitId, kind, dataJson, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({
            target: [commitNotes.commitId, commitNotes.kind],
            set: { dataJson, updatedAt: now },
          })
          .returning()
          .get(),
      );
      return toNoteRecord(row);
    },

    get(commitId, kind) {
      const row = ctx.db
        .select()
        .from(commitNotes)
        .where(and(eq(commitNotes.commitId, commitId), eq(commitNotes.kind, kind), owned()))
        .get();
      return row ? toNoteRecord(row) : null;
    },

    listForCommit(commitId) {
      return ctx.db
        .select()
        .from(commitNotes)
        .where(and(eq(commitNotes.commitId, commitId), owned()))
        .orderBy(asc(commitNotes.kind))
        .all()
        .map(toNoteRecord);
    },

    delete(commitId, kind) {
      const result = ctx.db
        .delete(commitNotes)
        .where(and(eq(commitNotes.commitId, commitId), eq(commitNotes.kind, kind), owned()))
        .run();
      return result.changes > 0;
    },
  };
}

function toNoteRecord(row: typeof commitNotes.$inferSelect): CommitNoteRecord {
  return {
    id: row.id,
    commitId: row.commitId,
    kind: row.kind,
    data: decodeJson(row.dataJson, `Note ${row.id}`),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
