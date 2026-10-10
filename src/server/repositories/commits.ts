/**
 * Commits: immutable, content-addressed versions of a deck. Inserted once, never
 * updated, and only deleted together with their deck (enforced by database triggers).
 */
import { and, count, desc, eq, getTableColumns, gte, lt, max } from 'drizzle-orm';

import { commitId } from '@/core/hash';
import type { SourceDeckMetadata } from '@/core/model';
import type { IngestMethod } from '@/integrations/deck-source';
import { branches, commits, decks } from '@/server/db/schema';

import { corruptData, decodeIngestMethod, decodeSourceMetadata, encodeJson } from './codec';
import { inWorkspace, referencing, withTransaction, type RepositoryContext } from './context';
import { RepositoryError } from './errors';

export interface CommitRecord {
  /** SHA-256 of the serialized commit object (`commitId` in `@/core/hash`). */
  id: string;
  deckId: string;
  /** Branch the version was committed on (informational; lineage follows `parentId`). */
  branchId: string;
  /** Per-deck, user-facing version number (`v12` → 12). */
  sequence: number;
  parentId: string | null;
  snapshotHash: string;
  rawBlobHash: string | null;
  message: string;
  /** ISO-8601 UTC timestamp with milliseconds; part of the commit id. */
  createdAt: string;
  ingestMethod: IngestMethod;
  /** When the committed state was fetched/captured from the source. */
  fetchedAt: string;
  sourceVersion: number | null;
  sourceUpdatedAt: string | null;
  sourceMetadata: SourceDeckMetadata;
}

/** Shortest commit id prefix accepted by {@link CommitRepository.findByIdPrefix}. */
export const MIN_COMMIT_ID_PREFIX_LENGTH = 4;

export interface CommitRepository {
  /**
   * Inserts a new version. The caller computes id and sequence; the repository
   * verifies the invariants that can never be repaired later, because commits are
   * immutable: the id is the commit object hash of the given content (the deck's current
   * `<source>:<externalId>`, snapshot, parent, createdAt, sourceVersion, message), the
   * branch and parent belong to the same deck, and the parent has a lower sequence.
   * Does not move any branch head (see `BranchRepository.setHead`).
   *
   * @throws {RepositoryError} `invalid-input` for an id that does not match the
   * content or a bad sequence; `not-found` for an unknown deck, branch, parent,
   * snapshot or raw blob; `conflict` when the id or the sequence already exists.
   */
  insert(commit: CommitRecord): Promise<CommitRecord>;
  getById(id: string): Promise<CommitRecord | null>;
  getBySequence(deckId: string, sequence: number): Promise<CommitRecord | null>;
  /**
   * Resolves an abbreviated commit id within a deck (case-insensitive). Returns `null`
   * when nothing matches, when the prefix is ambiguous, or when it is not at least
   * {@link MIN_COMMIT_ID_PREFIX_LENGTH} hex characters.
   */
  findByIdPrefix(deckId: string, prefix: string): Promise<CommitRecord | null>;
  /** The commit the deck's HEAD branch points at, or `null` before the first version. */
  head(deckId: string): Promise<CommitRecord | null>;
  /**
   * The chain of versions ending at `fromCommitId` (default: HEAD), oldest first,
   * following parent pointers. Empty when the deck has no versions or `fromCommitId`
   * is not a commit of the deck.
   */
  lineage(deckId: string, fromCommitId?: string): Promise<CommitRecord[]>;
  /** All versions of the deck, newest (highest sequence) first. */
  listForDeck(deckId: string): Promise<CommitRecord[]>;
  count(deckId: string): Promise<number>;
  /** Number of versions of every deck of the workspace that has any, in one query. */
  countByDeck(): Promise<Map<string, number>>;
  /** Highest sequence of the deck, or `null` before the first version. */
  maxSequence(deckId: string): Promise<number | null>;
}

export function createCommitRepository(ctx: RepositoryContext): CommitRepository {
  /** Commits of decks in the context's workspace. */
  const owned = () => inWorkspace(ctx, commits.deckId);

  return {
    async insert(commit) {
      if (!Number.isInteger(commit.sequence) || commit.sequence < 1) {
        throw new RepositoryError(
          'invalid-input',
          `Commit sequence must be a positive integer, got ${commit.sequence}`,
        );
      }
      return withTransaction(ctx, async ({ db }) => {
        const deck = await db
          .select({ source: decks.source, externalId: decks.externalId })
          .from(decks)
          .where(and(eq(decks.id, commit.deckId), eq(decks.workspaceId, ctx.workspaceId)))
          .get();
        if (!deck) throw new RepositoryError('not-found', `Deck ${commit.deckId} does not exist`);
        assertContentAddressed(commit, `${deck.source}:${deck.externalId}`);

        // Installation-wide on purpose: commit ids are the table's primary key.
        const existing = await db
          .select({ id: commits.id })
          .from(commits)
          .where(eq(commits.id, commit.id))
          .get();
        if (existing) throw new RepositoryError('conflict', `Commit ${commit.id} already exists`);
        const branch = await db
          .select({ deckId: branches.deckId })
          .from(branches)
          .where(eq(branches.id, commit.branchId))
          .get();
        if (branch?.deckId !== commit.deckId) {
          throw new RepositoryError(
            'not-found',
            `Branch ${commit.branchId} does not belong to deck ${commit.deckId}`,
          );
        }
        if (commit.parentId !== null) {
          const parent = await db
            .select({ deckId: commits.deckId, sequence: commits.sequence })
            .from(commits)
            .where(eq(commits.id, commit.parentId))
            .get();
          if (parent?.deckId !== commit.deckId) {
            throw new RepositoryError(
              'not-found',
              `Parent ${commit.parentId} is not a commit of deck ${commit.deckId}`,
            );
          }
          if (parent.sequence >= commit.sequence) {
            throw new RepositoryError(
              'invalid-input',
              `Commit sequence ${commit.sequence} must be greater than its parent's (${parent.sequence})`,
            );
          }
        }
        const taken = await db
          .select({ id: commits.id })
          .from(commits)
          .where(and(eq(commits.deckId, commit.deckId), eq(commits.sequence, commit.sequence)))
          .get();
        if (taken) {
          throw new RepositoryError(
            'conflict',
            `Deck ${commit.deckId} already has version ${commit.sequence}`,
          );
        }

        const values = {
          id: commit.id,
          deckId: commit.deckId,
          branchId: commit.branchId,
          sequence: commit.sequence,
          parentId: commit.parentId,
          snapshotHash: commit.snapshotHash,
          rawBlobHash: commit.rawBlobHash,
          message: commit.message,
          createdAt: commit.createdAt,
          ingestMethod: commit.ingestMethod,
          fetchedAt: commit.fetchedAt,
          sourceVersion: commit.sourceVersion,
          sourceUpdatedAt: commit.sourceUpdatedAt,
          sourceMetadataJson: encodeJson(commit.sourceMetadata, 'Source metadata'),
        };
        // Remaining references: snapshot and raw blob.
        await referencing(`Commit ${commit.id}`, () => db.insert(commits).values(values));
        return { ...commit };
      });
    },

    async getById(id) {
      const row = await ctx.db
        .select()
        .from(commits)
        .where(and(eq(commits.id, id), owned()))
        .get();
      return row ? toCommitRecord(row) : null;
    },

    async getBySequence(deckId, sequence) {
      const row = await ctx.db
        .select()
        .from(commits)
        .where(and(eq(commits.deckId, deckId), eq(commits.sequence, sequence), owned()))
        .get();
      return row ? toCommitRecord(row) : null;
    },

    async findByIdPrefix(deckId, prefix) {
      const normalized = prefix.trim().toLowerCase();
      if (!/^[0-9a-f]+$/.test(normalized) || normalized.length < MIN_COMMIT_ID_PREFIX_LENGTH) return null;
      // Ids are lowercase hex, so every id starting with the prefix sorts within
      // [prefix, prefix + 'g'): a primary-key range scan instead of LIKE.
      const [match, another] = await ctx.db
        .select()
        .from(commits)
        .where(
          and(
            eq(commits.deckId, deckId),
            gte(commits.id, normalized),
            lt(commits.id, `${normalized}g`),
            owned(),
          ),
        )
        .limit(2)
        .all();
      return match && !another ? toCommitRecord(match) : null;
    },

    async head(deckId) {
      const row = await ctx.db
        .select(getTableColumns(commits))
        .from(decks)
        .innerJoin(branches, and(eq(branches.deckId, decks.id), eq(branches.name, decks.headBranchName)))
        .innerJoin(commits, eq(commits.id, branches.headCommitId))
        .where(and(eq(decks.id, deckId), eq(decks.workspaceId, ctx.workspaceId)))
        .get();
      return row ? toCommitRecord(row) : null;
    },

    async lineage(deckId, fromCommitId) {
      const [rows, headId] = await Promise.all([
        ctx.db
          .select()
          .from(commits)
          .where(and(eq(commits.deckId, deckId), owned()))
          .all(),
        fromCommitId === undefined ? headCommitId(ctx, deckId) : Promise.resolve(fromCommitId),
      ]);
      const byId = new Map(rows.map((row) => [row.id, row]));
      const chain: (typeof commits.$inferSelect)[] = [];
      let cursor = headId;
      if (cursor !== null && !byId.has(cursor)) return [];
      while (cursor !== null) {
        const row = byId.get(cursor);
        if (!row) throw corruptData(`Lineage of deck ${deckId}`, `parent ${cursor} is missing`);
        chain.push(row);
        if (chain.length > rows.length)
          throw corruptData(`Lineage of deck ${deckId}`, 'parent pointers form a cycle');
        cursor = row.parentId;
      }
      return chain.reverse().map(toCommitRecord);
    },

    async listForDeck(deckId) {
      const rows = await ctx.db
        .select()
        .from(commits)
        .where(and(eq(commits.deckId, deckId), owned()))
        .orderBy(desc(commits.sequence))
        .all();
      return rows.map(toCommitRecord);
    },

    async count(deckId) {
      const row = await ctx.db
        .select({ n: count() })
        .from(commits)
        .where(and(eq(commits.deckId, deckId), owned()))
        .get();
      return row?.n ?? 0;
    },

    async countByDeck() {
      const rows = await ctx.db
        .select({ deckId: commits.deckId, n: count() })
        .from(commits)
        .where(owned())
        .groupBy(commits.deckId)
        .all();
      return new Map(rows.map((row) => [row.deckId, row.n]));
    },

    async maxSequence(deckId) {
      const row = await ctx.db
        .select({ value: max(commits.sequence) })
        .from(commits)
        .where(and(eq(commits.deckId, deckId), owned()))
        .get();
      return row?.value ?? null;
    },
  };
}

function assertContentAddressed(commit: CommitRecord, deckRef: string): void {
  let expected: string;
  try {
    expected = commitId({
      deck: deckRef,
      snapshotHash: commit.snapshotHash,
      parentId: commit.parentId,
      createdAt: commit.createdAt,
      sourceVersion: commit.sourceVersion,
      message: commit.message,
    });
  } catch (cause) {
    throw new RepositoryError('invalid-input', 'Commit cannot be serialized as a commit object', { cause });
  }
  if (commit.id !== expected) {
    throw new RepositoryError(
      'invalid-input',
      `Commit id ${commit.id} does not match its content (${expected})`,
    );
  }
}

async function headCommitId(ctx: RepositoryContext, deckId: string): Promise<string | null> {
  const row = await ctx.db
    .select({ headCommitId: branches.headCommitId })
    .from(decks)
    .innerJoin(branches, and(eq(branches.deckId, decks.id), eq(branches.name, decks.headBranchName)))
    .where(and(eq(decks.id, deckId), eq(decks.workspaceId, ctx.workspaceId)))
    .get();
  return row?.headCommitId ?? null;
}

/** Maps a `commits` row to its record. Shared with repositories that join commits. */
export function toCommitRecord(row: typeof commits.$inferSelect): CommitRecord {
  const what = `Commit ${row.id}`;
  return {
    id: row.id,
    deckId: row.deckId,
    branchId: row.branchId,
    sequence: row.sequence,
    parentId: row.parentId,
    snapshotHash: row.snapshotHash,
    rawBlobHash: row.rawBlobHash,
    message: row.message,
    createdAt: row.createdAt,
    ingestMethod: decodeIngestMethod(row.ingestMethod, what),
    fetchedAt: row.fetchedAt,
    sourceVersion: row.sourceVersion,
    sourceUpdatedAt: row.sourceUpdatedAt,
    sourceMetadata: decodeSourceMetadata(row.sourceMetadataJson, `${what} source metadata`),
  };
}
