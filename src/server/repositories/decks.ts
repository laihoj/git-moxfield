/**
 * Tracked decks. A deck row caches listing data (name, format, URL) and fetch status;
 * its history lives in branches, commits and observations, which are removed with it.
 */
import { and, asc, desc, eq, getTableColumns, ne, or, sql } from 'drizzle-orm';

import { isRecord } from '@/core/guards';
import { isDeckSourceErrorCode, type DeckSourceErrorCode } from '@/integrations/deck-source';
import { branches, commits, deckRelinks, decks, observations } from '@/server/db/schema';

import { corruptData, decodeJson, encodeJson } from './codec';
import { collectContentGarbage } from './content-gc';
import {
  isUniqueViolation,
  ownDeck,
  requireDeckInWorkspace,
  updateRows,
  withTransaction,
  writeAll,
  type LibsqlExecutor,
  type RepositoryContext,
} from './context';
import { RepositoryError } from './errors';

/** Name of the branch every deck is created with; new versions are committed to it. */
export const MAIN_BRANCH_NAME = 'main';

/** The most recent failed fetch of a deck. The service layer passes it on as its `FetchErrorDTO`. */
export interface FetchErrorRecord {
  code: DeckSourceErrorCode;
  message: string;
  /** ISO timestamp of the failed attempt. */
  at: string;
  retryAfterSeconds: number | null;
}

export interface DeckRecord {
  id: string;
  workspaceId: string;
  /** DeckSource id, e.g. `moxfield`. */
  source: string;
  /** Public deck id on the source. */
  externalId: string;
  /** Latest known deck URL, name and format (cached for listings). */
  url: string;
  name: string;
  format: string;
  /** Symbolic HEAD: the branch new versions are committed to. */
  headBranchName: string;
  lastFetchAttemptAt: string | null;
  /** Error of the most recent fetch, or `null` when it succeeded (or none happened). */
  lastFetchError: FetchErrorRecord | null;
  createdAt: string;
  /** Last change to the deck's cached info or to its version history. */
  updatedAt: string;
}

export interface NewDeck {
  source: string;
  externalId: string;
  url: string;
  name: string;
  format: string;
}

export interface DeckCachedInfo {
  name: string;
  format: string;
  url: string;
}

/** A change of a deck's source deck (see {@link DeckRepository.relink}). */
export interface DeckRelinkInput {
  /**
   * The external id the caller saw the deck follow: the change only happens while the
   * deck still follows it (compare-and-set), so two concurrent changes cannot both win.
   */
  expectedExternalId: string;
  /** The source deck to follow from now on (same source as the deck). */
  externalId: string;
  url: string;
}

/** One recorded change of a deck's source deck (`deck_relinks`). */
export type DeckRelinkRecord = typeof deckRelinks.$inferSelect;

export interface DeckRepository {
  /**
   * Starts tracking a deck: creates the deck and its `main` branch atomically.
   * @throws {RepositoryError} `conflict` when the deck is already tracked;
   * `invalid-input` when source or external id is empty.
   */
  create(input: NewDeck): Promise<DeckRecord>;
  getById(id: string): Promise<DeckRecord | null>;
  getBySourceExternal(source: string, externalId: string): Promise<DeckRecord | null>;
  /** All decks of the workspace, most recently updated first (then by name). */
  list(): Promise<DeckRecord[]>;
  /**
   * Refreshes the cached listing info. `updatedAt` only moves when a value actually
   * changed, so routine refreshes do not reorder the deck list.
   * @returns whether anything changed.
   * @throws {RepositoryError} `not-found` for an unknown deck.
   */
  updateCachedInfo(id: string, info: DeckCachedInfo): Promise<boolean>;
  /** @throws {RepositoryError} `not-found` for an unknown deck. */
  recordFetchAttempt(id: string, at: string): Promise<void>;
  /**
   * Records the error of the latest fetch, or clears it with `null` after a success.
   * @throws {RepositoryError} `not-found` for an unknown deck.
   */
  recordFetchError(id: string, error: FetchErrorRecord | null): Promise<void>;
  /**
   * Points a deck at another deck of its source (the user deleted the deck on the source
   * and made it again, under a new public id) and records the change, atomically. The
   * deck keeps its id, name, branches and versions; its fetch status (last attempt and
   * error) is cleared, since it described the previous source deck. Observations are not
   * touched: they describe the previous source deck, and the caller decides what becomes
   * of them (the services prune them in the same transaction).
   *
   * @returns the recorded change.
   * @throws {RepositoryError} `not-found` for an unknown deck; `conflict` when the deck no
   *   longer follows `expectedExternalId`, or another deck of the workspace tracks the new
   *   source deck; `invalid-input` for an empty external id or URL, or the deck's own.
   */
  relink(id: string, input: DeckRelinkInput): Promise<DeckRelinkRecord>;
  /** The deck's recorded source deck changes, oldest first; `[]` for an unknown deck. */
  listRelinks(id: string): Promise<DeckRelinkRecord[]>;
  /**
   * Deletes a deck with its entire history (branches, commits, observations, tags,
   * notes, recorded source deck changes). Snapshots and raw payloads that no other deck
   * references are removed too.
   * @returns `false` when the deck did not exist.
   */
  delete(id: string): Promise<boolean>;
}

export function createDeckRepository(ctx: RepositoryContext): DeckRepository {
  const inWorkspace = eq(decks.workspaceId, ctx.workspaceId);

  const findBySource = (db: LibsqlExecutor, source: string, externalId: string) =>
    db
      .select()
      .from(decks)
      .where(and(inWorkspace, eq(decks.source, source), eq(decks.externalId, externalId)))
      .get();

  const alreadyTracked = (
    input: Pick<NewDeck, 'source' | 'externalId'>,
    existingId: string,
    cause?: unknown,
  ): RepositoryError =>
    new RepositoryError(
      'conflict',
      `Deck ${input.source}:${input.externalId} is already tracked as ${existingId}`,
      cause === undefined ? undefined : { cause },
    );

  /** Sets columns of a deck of the workspace; `not-found` when there is none. */
  async function updateDeck(id: string, set: Partial<typeof decks.$inferInsert>): Promise<void> {
    const changed = await updateRows(ctx, decks, set, ownDeck(ctx, id));
    if (changed === 0) throw new RepositoryError('not-found', `Deck ${id} does not exist`);
  }

  return {
    async create(input) {
      if (input.source.trim() === '' || input.externalId.trim() === '') {
        throw new RepositoryError('invalid-input', 'A deck needs a source and an external id');
      }
      const existing = await findBySource(ctx.db, input.source, input.externalId);
      if (existing) throw alreadyTracked(input, existing.id);
      const now = ctx.now();
      const id = ctx.newId();
      const branchId = ctx.newId();
      try {
        // Deck and main branch in one atomic batch: one round trip, no transaction.
        const [inserted] = await writeAll(ctx, (db) => [
          db
            .insert(decks)
            .values({
              id,
              workspaceId: ctx.workspaceId,
              source: input.source,
              externalId: input.externalId,
              url: input.url,
              name: input.name,
              format: input.format,
              headBranchName: MAIN_BRANCH_NAME,
              createdAt: now,
              updatedAt: now,
            })
            .returning(),
          db.insert(branches).values({
            id: branchId,
            deckId: id,
            name: MAIN_BRANCH_NAME,
            kind: 'main',
            createdAt: now,
            updatedAt: now,
          }),
        ]);
        const row = inserted[0];
        if (!row) throw new Error(`Inserting deck ${id} returned no row`);
        return toDeckRecord(row);
      } catch (error) {
        // Another request tracked the same deck since the check above.
        if (!isUniqueViolation(error)) throw error;
        const raced = await findBySource(ctx.db, input.source, input.externalId);
        throw alreadyTracked(input, raced?.id ?? 'another deck', error);
      }
    },

    async getById(id) {
      const row = await ctx.db.select().from(decks).where(ownDeck(ctx, id)).get();
      return row ? toDeckRecord(row) : null;
    },

    async getBySourceExternal(source, externalId) {
      const row = await findBySource(ctx.db, source, externalId);
      return row ? toDeckRecord(row) : null;
    },

    async list() {
      const rows = await ctx.db
        .select()
        .from(decks)
        .where(inWorkspace)
        .orderBy(desc(decks.updatedAt), asc(decks.name), asc(decks.id))
        .all();
      return rows.map(toDeckRecord);
    },

    async updateCachedInfo(id, info) {
      const updatedAt = ctx.now();
      // One conditional UPDATE; only when nothing changed does telling "unchanged" from
      // "unknown deck" take a second (read-only) query.
      const changed = await updateRows(
        ctx,
        decks,
        { name: info.name, format: info.format, url: info.url, updatedAt },
        and(
          ownDeck(ctx, id),
          or(ne(decks.name, info.name), ne(decks.format, info.format), ne(decks.url, info.url)),
        ),
      );
      if (changed > 0) return true;
      await requireDeckInWorkspace(ctx, id);
      return false;
    },

    recordFetchAttempt(id, at) {
      return updateDeck(id, { lastFetchAttemptAt: at });
    },

    async recordFetchError(id, error) {
      return updateDeck(id, {
        lastFetchErrorJson: error === null ? null : encodeJson(error, 'Fetch error'),
      });
    },

    async relink(id, input) {
      if (input.externalId.trim() === '' || input.url.trim() === '') {
        throw new RepositoryError('invalid-input', 'A source deck needs an external id and a URL');
      }
      try {
        return await withTransaction(ctx, async ({ db }) => {
          const deck = await db.select().from(decks).where(ownDeck(ctx, id)).get();
          if (!deck) throw new RepositoryError('not-found', `Deck ${id} does not exist`);
          if (deck.externalId !== input.expectedExternalId) {
            throw new RepositoryError(
              'conflict',
              `Deck ${id} follows ${deck.source}:${deck.externalId}, not ${deck.source}:${input.expectedExternalId}`,
            );
          }
          if (input.externalId === deck.externalId) {
            throw new RepositoryError(
              'invalid-input',
              `Deck ${id} already follows ${deck.source}:${input.externalId}`,
            );
          }
          const other = await findBySource(db, deck.source, input.externalId);
          if (other) {
            throw alreadyTracked({ source: deck.source, externalId: input.externalId }, other.id);
          }
          const now = ctx.now();
          const record: DeckRelinkRecord = {
            id: ctx.newId(),
            deckId: id,
            previousExternalId: deck.externalId,
            previousUrl: deck.url,
            externalId: input.externalId,
            url: input.url,
            createdAt: now,
          };
          await db
            .update(decks)
            .set({
              externalId: input.externalId,
              url: input.url,
              lastFetchAttemptAt: null,
              lastFetchErrorJson: null,
              updatedAt: now,
            })
            .where(eq(decks.id, id));
          await db.insert(deckRelinks).values(record);
          return record;
        });
      } catch (error) {
        // Another request tracked the same source deck since the check above.
        if (!isUniqueViolation(error)) throw error;
        throw new RepositoryError('conflict', `Another deck already tracks ${input.externalId}`, {
          cause: error,
        });
      }
    },

    async listRelinks(id) {
      return ctx.db
        .select(getTableColumns(deckRelinks))
        .from(deckRelinks)
        .innerJoin(decks, eq(decks.id, deckRelinks.deckId))
        .where(and(inWorkspace, eq(deckRelinks.deckId, id)))
        .orderBy(asc(deckRelinks.createdAt), asc(sql`${deckRelinks}.rowid`))
        .all();
    },

    delete(id) {
      return withTransaction(ctx, async ({ db }) => {
        const deck = await db.select({ id: decks.id }).from(decks).where(ownDeck(ctx, id)).get();
        if (!deck) return false;
        const fromCommits = await db
          .selectDistinct({ snapshotHash: commits.snapshotHash, rawBlobHash: commits.rawBlobHash })
          .from(commits)
          .where(eq(commits.deckId, id))
          .all();
        const fromObservations = await db
          .selectDistinct({ snapshotHash: observations.snapshotHash, rawBlobHash: observations.rawBlobHash })
          .from(observations)
          .where(eq(observations.deckId, id))
          .all();
        const referenced = [...fromCommits, ...fromObservations];
        // Commits, branches, observations, tags and notes cascade; the commit
        // immutability trigger permits deletes once the owning deck row is gone.
        await db.delete(decks).where(eq(decks.id, id));
        await collectContentGarbage(db, referenced);
        return true;
      });
    },
  };
}

function decodeFetchError(text: string, deckId: string): FetchErrorRecord {
  const what = `Fetch error of deck ${deckId}`;
  const value = decodeJson(text, what);
  if (
    !isRecord(value) ||
    typeof value.code !== 'string' ||
    !isDeckSourceErrorCode(value.code) ||
    typeof value.message !== 'string' ||
    typeof value.at !== 'string' ||
    (value.retryAfterSeconds !== null && typeof value.retryAfterSeconds !== 'number')
  ) {
    throw corruptData(what, 'does not match the fetch error shape');
  }
  // Only these fields: the record is passed to the client as it is (`FetchErrorDTO`).
  const { code, message, at, retryAfterSeconds } = value;
  return { code, message, at, retryAfterSeconds };
}

function toDeckRecord(row: typeof decks.$inferSelect): DeckRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    source: row.source,
    externalId: row.externalId,
    url: row.url,
    name: row.name,
    format: row.format,
    headBranchName: row.headBranchName,
    lastFetchAttemptAt: row.lastFetchAttemptAt,
    lastFetchError: row.lastFetchErrorJson === null ? null : decodeFetchError(row.lastFetchErrorJson, row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
