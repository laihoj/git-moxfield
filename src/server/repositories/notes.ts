/**
 * Commit notes: mutable, structured annotations on immutable versions, in the spirit
 * of `git notes`. Each version has at most one note per `kind`; `kind` namespaces the
 * JSON payload (`note` for the free-text note today, see the services'
 * `FREE_TEXT_NOTE_KIND`; tournament results etc. later).
 */
import { and, asc, eq } from 'drizzle-orm';

import { commitNotes, commits } from '@/server/db/schema';

import { decodeJson, encodeJson } from './codec';
import { commitInWorkspace, deckInWorkspace, referencing, write, type RepositoryContext } from './context';
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
  upsert(commitId: string, kind: string, data: unknown): Promise<CommitNoteRecord>;
  get(commitId: string, kind: string): Promise<CommitNoteRecord | null>;
  /** All notes of a version, sorted by kind. */
  listForCommit(commitId: string): Promise<CommitNoteRecord[]>;
  /** Returns whether a note was deleted. */
  delete(commitId: string, kind: string): Promise<boolean>;
}

export function createCommitNoteRepository(ctx: RepositoryContext): CommitNoteRepository {
  /** Notes of the commit `commitId` if it is in the context's workspace. */
  const owned = (commitId: string) => commitInWorkspace(ctx, commitId);

  return {
    async upsert(commitId, kind, data) {
      if (!NOTE_KIND.test(kind)) {
        throw new RepositoryError('invalid-input', `Invalid note kind ${JSON.stringify(kind)}`);
      }
      const commit = await ctx.db
        .select({ id: commits.id })
        .from(commits)
        .where(and(eq(commits.id, commitId), deckInWorkspace(ctx, commits.deckId)))
        .get();
      if (!commit) throw new RepositoryError('not-found', `Commit ${commitId} does not exist`);
      const dataJson = encodeJson(data, 'Note data');
      const now = ctx.now();
      const id = ctx.newId();
      const row = await referencing(`Note ${kind}`, () =>
        write(ctx, (db) =>
          db
            .insert(commitNotes)
            .values({ id, commitId, kind, dataJson, createdAt: now, updatedAt: now })
            .onConflictDoUpdate({
              target: [commitNotes.commitId, commitNotes.kind],
              set: { dataJson, updatedAt: now },
            })
            .returning()
            .get(),
        ),
      );
      return toNoteRecord(row);
    },

    async get(commitId, kind) {
      const row = await ctx.db
        .select()
        .from(commitNotes)
        .where(and(eq(commitNotes.commitId, commitId), eq(commitNotes.kind, kind), owned(commitId)))
        .get();
      return row ? toNoteRecord(row) : null;
    },

    async listForCommit(commitId) {
      const rows = await ctx.db
        .select()
        .from(commitNotes)
        .where(and(eq(commitNotes.commitId, commitId), owned(commitId)))
        .orderBy(asc(commitNotes.kind))
        .all();
      return rows.map(toNoteRecord);
    },

    async delete(commitId, kind) {
      const result = await write(ctx, (db) =>
        db
          .delete(commitNotes)
          .where(and(eq(commitNotes.commitId, commitId), eq(commitNotes.kind, kind), owned(commitId))),
      );
      return result.rowsAffected > 0;
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
