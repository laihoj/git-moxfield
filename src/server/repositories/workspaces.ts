/**
 * Workspaces: the private spaces decks belong to. Every user owns exactly one (created
 * with the user, see `./users`); `local` is the workspace of single-user installations
 * that predate accounts, adopted by the first admin.
 *
 * Installation-wide: unlike the deck repositories, nothing here is scoped to the
 * context's workspace. The deck lookups ({@link WorkspaceRepository.locateDeck}) exist
 * for operator tools (command-line scripts) that must find a deck before they know whose
 * it is; the UI never uses them (it reaches decks only through workspace-bound services).
 */
import { and, asc, eq } from 'drizzle-orm';

import { decks, users, workspaces } from '@/server/db/schema';

import { write, type RepositoryContext } from './context';
import { RepositoryError } from './errors';

export type WorkspaceRecord = typeof workspaces.$inferSelect;

/** Where a deck lives: its workspace and that workspace's owner (if any). */
export interface DeckLocation {
  deckId: string;
  workspaceId: string;
  source: string;
  externalId: string;
  name: string;
  /** Display name of the user owning the workspace; `null` for an unowned workspace. */
  ownerDisplayName: string | null;
}

export interface WorkspaceRepository {
  /**
   * Creates a workspace with a fresh id.
   * @throws {RepositoryError} `invalid-input` for an empty name.
   */
  create(name: string): Promise<WorkspaceRecord>;
  getById(id: string): Promise<WorkspaceRecord | null>;
  /**
   * Whether the workspace holds any deck. For deciding about a workspace as a whole (the
   * first admin adopts the `local` workspace only when it has history); reveals no deck.
   */
  hasDecks(id: string): Promise<boolean>;
  /** Operator tools only: the deck with this git-moxfield id, in any workspace. */
  locateDeck(deckId: string): Promise<DeckLocation | null>;
  /** Operator tools only: every workspace's deck tracking this source deck, oldest first. */
  locateDecksBySource(source: string, externalId: string): Promise<DeckLocation[]>;
  /** Operator tools only: every deck of every workspace, by owner, then name. */
  locateAllDecks(): Promise<DeckLocation[]>;
}

export function createWorkspaceRepository(ctx: RepositoryContext): WorkspaceRepository {
  const locations = () =>
    ctx.db
      .select({
        deckId: decks.id,
        workspaceId: decks.workspaceId,
        source: decks.source,
        externalId: decks.externalId,
        name: decks.name,
        ownerDisplayName: users.displayName,
      })
      .from(decks)
      .leftJoin(users, eq(users.workspaceId, decks.workspaceId));

  return {
    async create(name) {
      const row = newWorkspaceRow(ctx, name);
      return write(ctx, (db) => db.insert(workspaces).values(row).returning().get());
    },

    async getById(id) {
      const row = await ctx.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
      return row ?? null;
    },

    async hasDecks(id) {
      const row = await ctx.db
        .select({ id: decks.id })
        .from(decks)
        .where(eq(decks.workspaceId, id))
        .limit(1)
        .get();
      return row !== undefined;
    },

    async locateDeck(deckId) {
      const row = await locations().where(eq(decks.id, deckId)).get();
      return row ?? null;
    },

    locateDecksBySource(source, externalId) {
      return locations()
        .where(and(eq(decks.source, source), eq(decks.externalId, externalId)))
        .orderBy(asc(decks.createdAt), asc(decks.id))
        .all();
    },

    locateAllDecks() {
      return locations().orderBy(asc(users.displayName), asc(decks.name), asc(decks.id)).all();
    },
  };
}

/**
 * The row of a new workspace with a fresh id. Shared with `./users`, which inserts it
 * together with the workspace's owner.
 * @throws {RepositoryError} `invalid-input` for an empty name.
 */
export function newWorkspaceRow(
  ctx: Pick<RepositoryContext, 'now' | 'newId'>,
  name: string,
): typeof workspaces.$inferInsert & WorkspaceRecord {
  const trimmed = name.trim();
  if (trimmed === '') throw new RepositoryError('invalid-input', 'A workspace needs a name');
  return { id: ctx.newId(), name: trimmed, createdAt: ctx.now() };
}
