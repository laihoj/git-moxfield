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

import type { DbExecutor, RepositoryContext } from './context';
import { RepositoryError } from './errors';

export interface WorkspaceRecord {
  id: string;
  name: string;
  createdAt: string;
}

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
  create(name: string): WorkspaceRecord;
  getById(id: string): WorkspaceRecord | null;
  /**
   * Whether the workspace holds any deck. For deciding about a workspace as a whole (the
   * first admin adopts the `local` workspace only when it has history); reveals no deck.
   */
  hasDecks(id: string): boolean;
  /** Operator tools only: the deck with this git-moxfield id, in any workspace. */
  locateDeck(deckId: string): DeckLocation | null;
  /** Operator tools only: every workspace's deck tracking this source deck, oldest first. */
  locateDecksBySource(source: string, externalId: string): DeckLocation[];
  /** Operator tools only: every deck of every workspace, by owner, then name. */
  locateAllDecks(): DeckLocation[];
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
    create(name) {
      return insertWorkspace(ctx.db, ctx, name);
    },

    getById(id) {
      return ctx.db.select().from(workspaces).where(eq(workspaces.id, id)).get() ?? null;
    },

    hasDecks(id) {
      return (
        ctx.db.select({ id: decks.id }).from(decks).where(eq(decks.workspaceId, id)).limit(1).get() !==
        undefined
      );
    },

    locateDeck(deckId) {
      return locations().where(eq(decks.id, deckId)).get() ?? null;
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

/** Inserts a workspace on `db` (the caller's transaction, if any). Shared with `./users`. */
export function insertWorkspace(
  db: DbExecutor,
  ctx: Pick<RepositoryContext, 'now' | 'newId'>,
  name: string,
): WorkspaceRecord {
  const trimmed = name.trim();
  if (trimmed === '') throw new RepositoryError('invalid-input', 'A workspace needs a name');
  return db
    .insert(workspaces)
    .values({ id: ctx.newId(), name: trimmed, createdAt: ctx.now() })
    .returning()
    .get();
}
