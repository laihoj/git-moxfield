/**
 * Copying decks' stored history from one git-moxfield database into another, row for row
 * (`pnpm import:local`, see `src/server/history-import/`). The other repositories create
 * history as it happens (new ids, the clock's timestamps, content hashed on the way in);
 * this one moves existing history without changing it: commit ids, timestamps, messages,
 * raw payloads and snapshots stay byte for byte what they were.
 *
 * Reading (the source database) is scoped to the bound workspace like every deck query.
 * Writing (the target database) puts decks into the bound workspace:
 *
 * - Content-addressed rows (snapshots with their card index, raw payloads) are written in
 *   atomic batches that skip what exists ({@link HistoryTransferRepository.insertSnapshots},
 *   {@link HistoryTransferRepository.insertRawBlobs}); they are shared by every workspace
 *   and invisible until history references them, so a failure between batches leaves
 *   nothing a deck shows.
 * - A deck's history (deck, branches, commits, observations, tags, notes, source deck
 *   changes) is written in one transaction ({@link HistoryTransferRepository.insertDeckHistory}),
 *   inserts only, so the immutability triggers hold: the deck appears complete or not at
 *   all, and never next to a copy of itself.
 *
 * Every row read is verified before it is written elsewhere: snapshots and raw payloads
 * against their content hash, commits against their content address.
 */
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

import { commitId, sha256Hex } from '@/core/hash';
import {
  branches,
  cardCatalog,
  commitNotes,
  commits,
  deckRelinks,
  decks,
  observations,
  rawBlobs,
  snapshotCards,
  snapshots,
  versionTags,
} from '@/server/db/schema';

import { classifySqlError } from '@/server/db/sql-errors';

import { corruptData } from './codec';
import {
  assertStorableSize,
  batches,
  distinct,
  isUniqueViolation,
  withTransaction,
  writeAll,
  type LibsqlExecutor,
  type RepositoryContext,
} from './context';
import { RepositoryError } from './errors';
import { inflateRawBlob } from './raw-blobs';
import { decodeSnapshot, snapshotCardRows } from './snapshots';

export type DeckRow = typeof decks.$inferSelect;
export type BranchRow = typeof branches.$inferSelect;
export type CommitRow = typeof commits.$inferSelect;
export type ObservationRow = typeof observations.$inferSelect;
export type VersionTagRow = typeof versionTags.$inferSelect;
export type CommitNoteRow = typeof commitNotes.$inferSelect;
export type DeckRelinkRow = typeof deckRelinks.$inferSelect;
export type SnapshotRow = typeof snapshots.$inferSelect;
export type RawBlobRow = typeof rawBlobs.$inferSelect;
export type CardCatalogRow = typeof cardCatalog.$inferSelect;

/** Everything stored about one deck's history except the content-addressed rows it references. */
export interface DeckHistoryRows {
  deck: DeckRow;
  branches: BranchRow[];
  /** Oldest (lowest sequence) first, so every parent comes before its children. */
  commits: CommitRow[];
  /** Oldest first. */
  observations: ObservationRow[];
  versionTags: VersionTagRow[];
  commitNotes: CommitNoteRow[];
  /** Oldest first. */
  relinks: DeckRelinkRow[];
}

/** Where a commit id is stored: commit ids are installation-wide (the table's primary key). */
export interface CommitLocation {
  commitId: string;
  deckId: string;
  workspaceId: string;
}

/** Tables whose rows have a random id that a copy keeps when it is free. */
export type TransferIdKind = 'deck' | 'branch' | 'observation' | 'note' | 'relink';

export interface HistoryTransferRepository {
  /** The deck's history rows, or `null` for a deck that is not the workspace's. */
  readDeckHistory(deckId: string): Promise<DeckHistoryRows | null>;
  /**
   * Snapshot rows by hash (content-addressed: any workspace's), each verified against its
   * hash and decodable by this build. Unknown hashes are absent.
   * @throws {RepositoryError} `corrupt-data` or `unsupported-version` for a damaged or
   *   unreadable snapshot.
   */
  readSnapshots(hashes: readonly string[]): Promise<SnapshotRow[]>;
  /**
   * Raw payload rows by hash, each verified against its hash. Unknown hashes are absent.
   * @throws {RepositoryError} `corrupt-data` or `unsupported-version`.
   */
  readRawBlobs(hashes: readonly string[]): Promise<RawBlobRow[]>;
  /** Stored sizes in bytes (canonical JSON of snapshots), without loading the rows. */
  snapshotSizes(hashes: readonly string[]): Promise<Map<string, number>>;
  /** Stored sizes in bytes (compressed payloads), without loading the rows. */
  rawBlobSizes(hashes: readonly string[]): Promise<Map<string, number>>;
  /** Every card key the snapshots hold, sorted. */
  cardKeysOf(snapshotHashes: readonly string[]): Promise<string[]>;
  /** The workspace's card catalog rows for `keys`. */
  readCatalog(keys: readonly string[]): Promise<CardCatalogRow[]>;

  /** Those of `hashes` that no snapshot has. */
  missingSnapshots(hashes: readonly string[]): Promise<string[]>;
  /** Those of `hashes` that no raw payload has. */
  missingRawBlobs(hashes: readonly string[]): Promise<string[]>;
  /** Where these commit ids are stored, in any workspace. */
  locateCommits(ids: readonly string[]): Promise<CommitLocation[]>;
  /** Those of `ids` that rows of `kind` use already, in any workspace. */
  takenIds(kind: TransferIdKind, ids: readonly string[]): Promise<Set<string>>;
  /**
   * Stores snapshots with their card index rows (derived from the snapshot, as
   * `SnapshotRepository.put` does) in one atomic batch; known snapshots are skipped.
   * @throws {RepositoryError} `corrupt-data`/`unsupported-version` for a row that does not
   *   verify; `invalid-input` for one too large to store (`MAX_STORED_VALUE_BYTES`).
   */
  insertSnapshots(rows: readonly SnapshotRow[]): Promise<void>;
  /**
   * Stores raw payloads as they are (compressed bytes, media type, timestamps) in one
   * atomic batch; known ones are skipped.
   * @throws {RepositoryError} as {@link insertSnapshots}.
   */
  insertRawBlobs(rows: readonly RawBlobRow[]): Promise<void>;
  /**
   * Stores a deck's history in the bound workspace in one transaction. Ids are written as
   * given (the caller replaces taken ones); the deck goes into the bound workspace whatever
   * its row says. The snapshots and raw payloads it references must be stored already.
   *
   * @throws {RepositoryError} `conflict` when the workspace tracks the deck's source deck
   *   already, or a commit or other id is taken; `invalid-input` when a commit's id is not
   *   the hash of its content under one of the deck's references (see {@link deckReferences})
   *   or a branch, parent or tag references something outside the deck; `not-found` for a
   *   snapshot or raw payload that is not stored.
   */
  insertDeckHistory(rows: DeckHistoryRows): Promise<void>;
  /**
   * Merges card catalog rows into the workspace's catalog, keeping for each card the facts
   * written last (`updated_at`), so merging twice changes nothing. One atomic batch.
   */
  mergeCatalog(rows: readonly CardCatalogRow[]): Promise<void>;
}

/**
 * The source deck references (`<source>:<externalId>`) a deck's commits may hash: its
 * current one and every one it followed before ("Change Moxfield deck"). A commit object's
 * `deck` header records the reference at commit time.
 */
export function deckReferences(
  deck: Pick<DeckRow, 'source' | 'externalId'>,
  relinks: readonly DeckRelinkRow[],
): string[] {
  return distinct([
    `${deck.source}:${deck.externalId}`,
    ...relinks.flatMap((relink) => [
      `${deck.source}:${relink.previousExternalId}`,
      `${deck.source}:${relink.externalId}`,
    ]),
  ]);
}

/**
 * Throws unless every commit's id is the hash of its content under one of `references`.
 * @throws {RepositoryError} `invalid-input` naming the first commit that does not verify.
 */
export function assertCommitsContentAddressed(
  rows: readonly CommitRow[],
  references: readonly string[],
): void {
  for (const row of rows) {
    const verified = references.some((deck) => {
      try {
        return (
          commitId({
            deck,
            snapshotHash: row.snapshotHash,
            parentId: row.parentId,
            createdAt: row.createdAt,
            sourceVersion: row.sourceVersion,
            message: row.message,
          }) === row.id
        );
      } catch {
        return false;
      }
    });
    if (!verified) {
      throw new RepositoryError(
        'invalid-input',
        `Version v${row.sequence} (commit ${row.id}) does not match its content under any of the deck's references (${references.join(', ')})`,
      );
    }
  }
}

/** Rows per multi-row statement for the wide history tables (commit rows carry metadata JSON). */
const HISTORY_ROWS_PER_STATEMENT = 100;

export function createHistoryTransferRepository(ctx: RepositoryContext): HistoryTransferRepository {
  /** `column IN (values)` over batches, collecting the selected rows. */
  async function selectIn<T>(
    values: readonly string[],
    query: (batch: string[]) => PromiseLike<T[]>,
  ): Promise<T[]> {
    const pages = await Promise.all(batches(distinct(values)).map((batch) => query(batch)));
    return pages.flat();
  }

  async function existing(column: SQLiteColumn, values: readonly string[]): Promise<Set<string>> {
    const table = column.table;
    const rows = await selectIn(values, (batch) =>
      ctx.db
        .select({ value: sql<string>`${column}` })
        .from(table)
        .where(inArray(column, batch))
        .all(),
    );
    return new Set(rows.map((row) => row.value));
  }

  const ID_COLUMNS: Record<TransferIdKind, SQLiteColumn> = {
    deck: decks.id,
    branch: branches.id,
    observation: observations.id,
    note: commitNotes.id,
    relink: deckRelinks.id,
  };

  return {
    async readDeckHistory(deckId) {
      const deck = await ctx.db
        .select()
        .from(decks)
        .where(and(eq(decks.id, deckId), eq(decks.workspaceId, ctx.workspaceId)))
        .get();
      if (!deck) return null;
      const ofDeckCommits = (column: SQLiteColumn): SQL =>
        inArray(column, ctx.db.select({ id: commits.id }).from(commits).where(eq(commits.deckId, deckId)));
      const [branchRows, commitRows, observationRows, tagRows, noteRows, relinkRows] = await Promise.all([
        ctx.db
          .select()
          .from(branches)
          .where(eq(branches.deckId, deckId))
          .orderBy(asc(branches.createdAt), asc(branches.id))
          .all(),
        ctx.db.select().from(commits).where(eq(commits.deckId, deckId)).orderBy(asc(commits.sequence)).all(),
        ctx.db
          .select()
          .from(observations)
          .where(eq(observations.deckId, deckId))
          .orderBy(asc(observations.fetchedAt), asc(sql`${observations}.rowid`))
          .all(),
        ctx.db
          .select()
          .from(versionTags)
          .where(ofDeckCommits(versionTags.commitId))
          .orderBy(asc(versionTags.commitId), asc(versionTags.name))
          .all(),
        ctx.db
          .select()
          .from(commitNotes)
          .where(ofDeckCommits(commitNotes.commitId))
          .orderBy(asc(commitNotes.commitId), asc(commitNotes.kind))
          .all(),
        ctx.db
          .select()
          .from(deckRelinks)
          .where(eq(deckRelinks.deckId, deckId))
          .orderBy(asc(deckRelinks.createdAt), asc(sql`${deckRelinks}.rowid`))
          .all(),
      ]);
      return {
        deck,
        branches: branchRows,
        commits: commitRows,
        observations: observationRows,
        versionTags: tagRows,
        commitNotes: noteRows,
        relinks: relinkRows,
      };
    },

    async readSnapshots(hashes) {
      const rows = await selectIn(hashes, (batch) =>
        ctx.db.select().from(snapshots).where(inArray(snapshots.hash, batch)).all(),
      );
      for (const row of rows) verifySnapshot(row);
      return rows;
    },

    async readRawBlobs(hashes) {
      const rows = await selectIn(hashes, (batch) =>
        ctx.db.select().from(rawBlobs).where(inArray(rawBlobs.hash, batch)).all(),
      );
      for (const row of rows) await inflateRawBlob(row);
      return rows;
    },

    async snapshotSizes(hashes) {
      const rows = await selectIn(hashes, (batch) =>
        ctx.db
          .select({
            hash: snapshots.hash,
            bytes: sql<number>`length(CAST(${snapshots.canonicalJson} AS BLOB))`,
          })
          .from(snapshots)
          .where(inArray(snapshots.hash, batch))
          .all(),
      );
      return new Map(rows.map((row) => [row.hash, row.bytes]));
    },

    async rawBlobSizes(hashes) {
      const rows = await selectIn(hashes, (batch) =>
        ctx.db
          .select({ hash: rawBlobs.hash, bytes: sql<number>`length(${rawBlobs.data})` })
          .from(rawBlobs)
          .where(inArray(rawBlobs.hash, batch))
          .all(),
      );
      return new Map(rows.map((row) => [row.hash, row.bytes]));
    },

    async cardKeysOf(snapshotHashes) {
      const rows = await selectIn(snapshotHashes, (batch) =>
        ctx.db
          .selectDistinct({ key: snapshotCards.cardKey })
          .from(snapshotCards)
          .where(inArray(snapshotCards.snapshotHash, batch))
          .all(),
      );
      return distinct(rows.map((row) => row.key)).sort();
    },

    readCatalog(keys) {
      return selectIn(keys, (batch) =>
        ctx.db
          .select()
          .from(cardCatalog)
          .where(and(eq(cardCatalog.workspaceId, ctx.workspaceId), inArray(cardCatalog.key, batch)))
          .all(),
      );
    },

    async missingSnapshots(hashes) {
      const known = await existing(snapshots.hash, hashes);
      return distinct(hashes).filter((hash) => !known.has(hash));
    },

    async missingRawBlobs(hashes) {
      const known = await existing(rawBlobs.hash, hashes);
      return distinct(hashes).filter((hash) => !known.has(hash));
    },

    locateCommits(ids) {
      return selectIn(ids, (batch) =>
        ctx.db
          .select({ commitId: commits.id, deckId: commits.deckId, workspaceId: decks.workspaceId })
          .from(commits)
          .innerJoin(decks, eq(decks.id, commits.deckId))
          .where(inArray(commits.id, batch))
          .all(),
      );
    },

    takenIds(kind, ids) {
      return existing(ID_COLUMNS[kind], ids);
    },

    async insertSnapshots(rows) {
      const [first, ...rest] = rows.map((row) => {
        const snapshot = verifySnapshot(row);
        assertStorableSize(`Snapshot ${row.hash}`, Buffer.byteLength(row.canonicalJson, 'utf8'));
        return { row, cards: snapshotCardRows(row.hash, snapshot) };
      });
      if (first === undefined) return;
      const all = [first, ...rest];
      await writeAll(ctx, (db) => [
        db
          .insert(snapshots)
          .values(all.map(({ row }) => row))
          .onConflictDoNothing(),
        ...batches(all.flatMap(({ cards }) => cards)).map((batch) =>
          db.insert(snapshotCards).values(batch).onConflictDoNothing(),
        ),
      ]);
    },

    async insertRawBlobs(rows) {
      if (rows.length === 0) return;
      for (const row of rows) {
        await inflateRawBlob(row);
        assertStorableSize(`Raw payload ${row.hash} (compressed)`, row.data.byteLength);
      }
      await writeAll(ctx, (db) => [
        db
          .insert(rawBlobs)
          .values([...rows])
          .onConflictDoNothing(),
      ]);
    },

    async insertDeckHistory(rows) {
      const deck: DeckRow = { ...rows.deck, workspaceId: ctx.workspaceId };
      assertConsistent({ ...rows, deck });
      try {
        await withTransaction(ctx, async ({ db }) => {
          await assertInsertable(db, ctx.workspaceId, { ...rows, deck });
          await db.insert(decks).values(deck);
          await insertChunks(
            db,
            branches,
            rows.branches.map((branch) => ({ ...branch, headCommitId: null, baseCommitId: null })),
          );
          await insertChunks(db, commits, rows.commits);
          for (const branch of rows.branches) {
            if (branch.headCommitId === null && branch.baseCommitId === null) continue;
            await db
              .update(branches)
              .set({ headCommitId: branch.headCommitId, baseCommitId: branch.baseCommitId })
              .where(eq(branches.id, branch.id));
          }
          await insertChunks(db, observations, rows.observations);
          await insertChunks(db, versionTags, rows.versionTags);
          await insertChunks(db, commitNotes, rows.commitNotes);
          await insertChunks(db, deckRelinks, rows.relinks);
        });
      } catch (error) {
        if (classifySqlError(error).kind === 'foreign-key') {
          throw new RepositoryError(
            'not-found',
            `Deck ${deck.source}:${deck.externalId} references a snapshot or raw payload that is not stored`,
            { cause: error },
          );
        }
        if (!isUniqueViolation(error)) throw error;
        throw new RepositoryError(
          'conflict',
          `Deck ${deck.source}:${deck.externalId} (or one of its rows) was stored by someone else meanwhile`,
          { cause: error },
        );
      }
    },

    async mergeCatalog(rows) {
      if (rows.length === 0) return;
      const latest = new Map<string, CardCatalogRow>();
      for (const row of rows) {
        const known = latest.get(row.key);
        if (known === undefined || row.updatedAt > known.updatedAt) latest.set(row.key, row);
      }
      const values = [...latest.values()].map((row) => ({ ...row, workspaceId: ctx.workspaceId }));
      const [first = [], ...rest] = batches(values);
      await writeAll(ctx, (db) => {
        const upsert = (batch: typeof values) =>
          db
            .insert(cardCatalog)
            .values(batch)
            .onConflictDoUpdate({
              target: [cardCatalog.workspaceId, cardCatalog.key],
              set: {
                name: excluded(cardCatalog.name),
                typeLine: excluded(cardCatalog.typeLine),
                primaryType: excluded(cardCatalog.primaryType),
                manaCost: excluded(cardCatalog.manaCost),
                cmc: excluded(cardCatalog.cmc),
                colorIdentityJson: excluded(cardCatalog.colorIdentityJson),
                layout: excluded(cardCatalog.layout),
                scryfallId: excluded(cardCatalog.scryfallId),
                updatedAt: excluded(cardCatalog.updatedAt),
              },
              // The facts written last win, wherever they were written.
              setWhere: sql`${excluded(cardCatalog.updatedAt)} > ${cardCatalog.updatedAt}`,
            });
        return [upsert(first), ...rest.map(upsert)] as const;
      });
    },
  };
}

/** Verifies a snapshot row against its hash and decodes it. */
function verifySnapshot(row: SnapshotRow): ReturnType<typeof decodeSnapshot> {
  if (sha256Hex(row.canonicalJson) !== row.hash) {
    throw corruptData(`Snapshot ${row.hash}`, 'content does not match its hash');
  }
  return decodeSnapshot(row);
}

/**
 * Checks that the rows form one deck's history: everything belongs to the deck, commits
 * verify and come parents first, branch heads and tags point at the deck's commits.
 */
function assertConsistent(rows: DeckHistoryRows): void {
  const { deck } = rows;
  const invalid = (problem: string): never => {
    throw new RepositoryError('invalid-input', `Deck ${deck.source}:${deck.externalId}: ${problem}`);
  };
  const branchIds = new Set(rows.branches.map((branch) => branch.id));
  const commitIds = new Set<string>();
  for (const branch of rows.branches)
    if (branch.deckId !== deck.id) invalid(`branch ${branch.name} is another deck's`);
  for (const commit of rows.commits) {
    if (commit.deckId !== deck.id) invalid(`version v${commit.sequence} is another deck's`);
    if (!branchIds.has(commit.branchId)) invalid(`version v${commit.sequence} is on an unknown branch`);
    if (commit.parentId !== null && !commitIds.has(commit.parentId)) {
      invalid(`version v${commit.sequence} comes before its parent`);
    }
    commitIds.add(commit.id);
  }
  assertCommitsContentAddressed(rows.commits, deckReferences(deck, rows.relinks));
  for (const branch of rows.branches) {
    for (const pointer of [branch.headCommitId, branch.baseCommitId]) {
      if (pointer !== null && !commitIds.has(pointer))
        invalid(`branch ${branch.name} points outside the deck`);
    }
  }
  for (const row of [...rows.observations, ...rows.relinks])
    if (row.deckId !== deck.id) invalid('a row is another deck’s');
  for (const row of [...rows.versionTags, ...rows.commitNotes]) {
    if (!commitIds.has(row.commitId)) invalid(`a tag or note is on another deck's version`);
  }
}

/** Refuses a deck history whose deck, source deck, commits or row ids are taken in the target. */
async function assertInsertable(
  db: LibsqlExecutor,
  workspaceId: string,
  rows: DeckHistoryRows,
): Promise<void> {
  const { deck } = rows;
  const conflict = (problem: string): never => {
    throw new RepositoryError('conflict', `Deck ${deck.source}:${deck.externalId}: ${problem}`);
  };
  const tracked = await db
    .select({ id: decks.id })
    .from(decks)
    .where(
      and(
        eq(decks.workspaceId, workspaceId),
        eq(decks.source, deck.source),
        eq(decks.externalId, deck.externalId),
      ),
    )
    .get();
  if (tracked) conflict(`the workspace tracks it already (deck ${tracked.id})`);
  const taken = async (column: SQLiteColumn, ids: readonly string[]): Promise<boolean> => {
    for (const batch of batches(distinct(ids))) {
      const row = await db
        .select({ one: sql<number>`1` })
        .from(column.table)
        .where(inArray(column, batch))
        .limit(1)
        .get();
      if (row) return true;
    }
    return false;
  };
  if (await taken(decks.id, [deck.id])) conflict(`deck id ${deck.id} is taken`);
  if (
    await taken(
      commits.id,
      rows.commits.map((commit) => commit.id),
    )
  )
    conflict('some of its versions are stored already');
  if (
    await taken(
      branches.id,
      rows.branches.map((branch) => branch.id),
    )
  )
    conflict('a branch id is taken');
  if (
    await taken(
      observations.id,
      rows.observations.map((row) => row.id),
    )
  )
    conflict('an observation id is taken');
  if (
    await taken(
      commitNotes.id,
      rows.commitNotes.map((row) => row.id),
    )
  )
    conflict('a note id is taken');
  if (
    await taken(
      deckRelinks.id,
      rows.relinks.map((row) => row.id),
    )
  )
    conflict('a relink id is taken');
}

/** Inserts rows in multi-row statements of at most {@link HISTORY_ROWS_PER_STATEMENT}, in order. */
async function insertChunks<
  T extends
    | typeof branches
    | typeof commits
    | typeof observations
    | typeof versionTags
    | typeof commitNotes
    | typeof deckRelinks,
>(db: LibsqlExecutor, table: T, rows: readonly T['$inferInsert'][]): Promise<void> {
  for (const batch of batches(rows, HISTORY_ROWS_PER_STATEMENT)) {
    await db.insert(table).values(batch);
  }
}

/** The value an upsert tried to insert into `column` (SQLite's `excluded` pseudo-table). */
function excluded(column: SQLiteColumn): SQL {
  return sql.raw(`excluded."${column.name}"`);
}
