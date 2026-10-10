/**
 * Tracked decks. A deck row caches listing data (name, format, URL) and fetch status;
 * its history lives in branches, commits and observations, which are removed with it.
 */
import { and, asc, desc, eq, ne, or } from 'drizzle-orm';

import type { DeckSourceErrorCode } from '@/integrations/deck-source';
import { branches, commits, decks, observations } from '@/server/db/schema';

import { corruptData, decodeJson, encodeJson, isRecord } from './codec';
import {
  isUniqueViolation,
  withTransaction,
  write,
  writeAll,
  type LibsqlExecutor,
  type RepositoryContext,
} from './context';
import { RepositoryError } from './errors';
import { deleteUnreferencedRawBlobs } from './raw-blobs';
import { deleteUnreferencedSnapshots } from './snapshots';

/** Name of the branch every deck is created with; new versions are committed to it. */
export const MAIN_BRANCH_NAME = 'main';

/** The most recent failed fetch of a deck (shape of the service layer's `FetchErrorDTO`). */
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
   * Deletes a deck with its entire history (branches, commits, observations, tags,
   * notes). Snapshots and raw payloads that no other deck references are removed too.
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

  const alreadyTracked = (input: NewDeck, existingId: string, cause?: unknown): RepositoryError =>
    new RepositoryError(
      'conflict',
      `Deck ${input.source}:${input.externalId} is already tracked as ${existingId}`,
      cause === undefined ? undefined : { cause },
    );

  async function requireDeck(db: LibsqlExecutor, id: string): Promise<void> {
    const row = await db
      .select({ id: decks.id })
      .from(decks)
      .where(and(inWorkspace, eq(decks.id, id)))
      .get();
    if (!row) throw new RepositoryError('not-found', `Deck ${id} does not exist`);
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
      const row = await ctx.db
        .select()
        .from(decks)
        .where(and(inWorkspace, eq(decks.id, id)))
        .get();
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
      const result = await write(ctx, (db) =>
        db
          .update(decks)
          .set({ name: info.name, format: info.format, url: info.url, updatedAt })
          .where(
            and(
              inWorkspace,
              eq(decks.id, id),
              or(ne(decks.name, info.name), ne(decks.format, info.format), ne(decks.url, info.url)),
            ),
          ),
      );
      if (result.rowsAffected > 0) return true;
      await requireDeck(ctx.db, id);
      return false;
    },

    async recordFetchAttempt(id, at) {
      const result = await write(ctx, (db) =>
        db
          .update(decks)
          .set({ lastFetchAttemptAt: at })
          .where(and(inWorkspace, eq(decks.id, id))),
      );
      if (result.rowsAffected === 0) throw new RepositoryError('not-found', `Deck ${id} does not exist`);
    },

    async recordFetchError(id, error) {
      const lastFetchErrorJson = error === null ? null : encodeJson(error, 'Fetch error');
      const result = await write(ctx, (db) =>
        db
          .update(decks)
          .set({ lastFetchErrorJson })
          .where(and(inWorkspace, eq(decks.id, id))),
      );
      if (result.rowsAffected === 0) throw new RepositoryError('not-found', `Deck ${id} does not exist`);
    },

    delete(id) {
      return withTransaction(ctx, async ({ db }) => {
        const deck = await db
          .select({ id: decks.id })
          .from(decks)
          .where(and(inWorkspace, eq(decks.id, id)))
          .get();
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
        await deleteUnreferencedSnapshots(
          db,
          referenced.map((r) => r.snapshotHash),
        );
        await deleteUnreferencedRawBlobs(
          db,
          referenced.flatMap((r) => (r.rawBlobHash === null ? [] : [r.rawBlobHash])),
        );
        return true;
      });
    },
  };
}

const FETCH_ERROR_CODES: Record<DeckSourceErrorCode, true> = {
  'invalid-ref': true,
  'not-found': true,
  forbidden: true,
  blocked: true,
  'rate-limited': true,
  unavailable: true,
  timeout: true,
  network: true,
  schema: true,
};

function decodeFetchError(text: string, deckId: string): FetchErrorRecord {
  const what = `Fetch error of deck ${deckId}`;
  const value = decodeJson(text, what);
  if (
    !isRecord(value) ||
    typeof value.code !== 'string' ||
    !Object.hasOwn(FETCH_ERROR_CODES, value.code) ||
    typeof value.message !== 'string' ||
    typeof value.at !== 'string' ||
    (value.retryAfterSeconds !== null && typeof value.retryAfterSeconds !== 'number')
  ) {
    throw corruptData(what, 'does not match the fetch error shape');
  }
  return value as unknown as FetchErrorRecord;
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
