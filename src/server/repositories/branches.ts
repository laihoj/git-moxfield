/**
 * Branches: named lines of history per deck. A branch head is the only mutable
 * pointer in the history model; everything it points at is immutable.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { branches, commits, decks } from '@/server/db/schema';

import { inWorkspace, withTransaction, type RepositoryContext } from './context';
import { RepositoryError } from './errors';

export type BranchKind = (typeof branches.$inferSelect)['kind'];

export interface BranchRecord {
  id: string;
  deckId: string;
  name: string;
  kind: BranchKind;
  /** Newest commit on the branch, `null` before the first version. */
  headCommitId: string | null;
  /** Commit an experiment branch was started from (`null` for `main`). */
  baseCommitId: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SetHeadOptions {
  /**
   * Compare-and-set: when given, the head is only moved if it currently equals this
   * value (`null` = branch has no head yet).
   */
  expectedHeadCommitId?: string | null;
}

export interface BranchRepository {
  /** The deck's `main` branch (`null` only for an unknown deck). */
  getMain(deckId: string): BranchRecord | null;
  getByName(deckId: string, name: string): BranchRecord | null;
  getById(id: string): BranchRecord | null;
  /** All branches of a deck: `main` first, then by name. */
  list(deckId: string): BranchRecord[];
  /**
   * Moves a branch head to a commit of the same deck and marks the deck as updated.
   * @throws {RepositoryError} `not-found` for an unknown branch or a commit that is not
   * part of the branch's deck; `conflict` when `expectedHeadCommitId` does not match.
   */
  setHead(branchId: string, commitId: string, options?: SetHeadOptions): void;
}

export function createBranchRepository(ctx: RepositoryContext): BranchRepository {
  /** Branches of decks in the context's workspace. */
  const owned = () => inWorkspace(ctx, branches.deckId);

  return {
    getMain(deckId) {
      const row = ctx.db
        .select()
        .from(branches)
        .where(and(eq(branches.deckId, deckId), eq(branches.kind, 'main'), owned()))
        .get();
      return row ?? null;
    },

    getByName(deckId, name) {
      const row = ctx.db
        .select()
        .from(branches)
        .where(and(eq(branches.deckId, deckId), eq(branches.name, name), owned()))
        .get();
      return row ?? null;
    },

    getById(id) {
      return (
        ctx.db
          .select()
          .from(branches)
          .where(and(eq(branches.id, id), owned()))
          .get() ?? null
      );
    },

    list(deckId) {
      return ctx.db
        .select()
        .from(branches)
        .where(and(eq(branches.deckId, deckId), owned()))
        .orderBy(sql`${branches.kind} <> 'main'`, asc(branches.name))
        .all();
    },

    setHead(branchId, commitId, options = {}) {
      withTransaction(ctx, (tx) => {
        const { db } = tx;
        const branch = db
          .select()
          .from(branches)
          .where(and(eq(branches.id, branchId), inWorkspace(tx, branches.deckId)))
          .get();
        if (!branch) throw new RepositoryError('not-found', `Branch ${branchId} does not exist`);
        const commit = db
          .select({ id: commits.id })
          .from(commits)
          .where(and(eq(commits.id, commitId), eq(commits.deckId, branch.deckId)))
          .get();
        if (!commit) {
          throw new RepositoryError(
            'not-found',
            `Commit ${commitId} does not belong to deck ${branch.deckId}`,
          );
        }
        const { expectedHeadCommitId } = options;
        if (expectedHeadCommitId !== undefined && branch.headCommitId !== expectedHeadCommitId) {
          throw new RepositoryError(
            'conflict',
            `Branch ${branch.name} moved: expected head ${expectedHeadCommitId ?? 'none'}, found ${branch.headCommitId ?? 'none'}`,
          );
        }
        const now = ctx.now();
        db.update(branches)
          .set({ headCommitId: commitId, updatedAt: now })
          .where(eq(branches.id, branchId))
          .run();
        db.update(decks).set({ updatedAt: now }).where(eq(decks.id, branch.deckId)).run();
      });
    },
  };
}
