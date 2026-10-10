/**
 * Branches: named lines of history per deck. A branch head is the only mutable
 * pointer in the history model; everything it points at is immutable.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { branches, commits, decks } from '@/server/db/schema';

import { deckInWorkspace, withTransaction, type RepositoryContext } from './context';
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
  getMain(deckId: string): Promise<BranchRecord | null>;
  getByName(deckId: string, name: string): Promise<BranchRecord | null>;
  getById(id: string): Promise<BranchRecord | null>;
  /** All branches of a deck: `main` first, then by name. */
  list(deckId: string): Promise<BranchRecord[]>;
  /**
   * Moves a branch head to a commit of the same deck and marks the deck as updated.
   * @throws {RepositoryError} `not-found` for an unknown branch or a commit that is not
   * part of the branch's deck; `conflict` when `expectedHeadCommitId` does not match.
   */
  setHead(branchId: string, commitId: string, options?: SetHeadOptions): Promise<void>;
}

export function createBranchRepository(ctx: RepositoryContext): BranchRepository {
  /** Branches of `deck` (a deck id, or the row's own deck) if it is in the context's workspace. */
  const owned = (deck: string | typeof branches.deckId) => deckInWorkspace(ctx, deck);

  return {
    async getMain(deckId) {
      const row = await ctx.db
        .select()
        .from(branches)
        .where(and(eq(branches.deckId, deckId), eq(branches.kind, 'main'), owned(deckId)))
        .get();
      return row ?? null;
    },

    async getByName(deckId, name) {
      const row = await ctx.db
        .select()
        .from(branches)
        .where(and(eq(branches.deckId, deckId), eq(branches.name, name), owned(deckId)))
        .get();
      return row ?? null;
    },

    async getById(id) {
      const row = await ctx.db
        .select()
        .from(branches)
        .where(and(eq(branches.id, id), owned(branches.deckId)))
        .get();
      return row ?? null;
    },

    list(deckId) {
      return ctx.db
        .select()
        .from(branches)
        .where(and(eq(branches.deckId, deckId), owned(deckId)))
        .orderBy(sql`${branches.kind} <> 'main'`, asc(branches.name))
        .all();
    },

    async setHead(branchId, commitId, options = {}) {
      await withTransaction(ctx, async (tx) => {
        const { db } = tx;
        const branch = await db
          .select()
          .from(branches)
          .where(and(eq(branches.id, branchId), deckInWorkspace(tx, branches.deckId)))
          .get();
        if (!branch) throw new RepositoryError('not-found', `Branch ${branchId} does not exist`);
        const commit = await db
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
        await db
          .update(branches)
          .set({ headCommitId: commitId, updatedAt: now })
          .where(eq(branches.id, branchId));
        await db.update(decks).set({ updatedAt: now }).where(eq(decks.id, branch.deckId));
      });
    },
  };
}
