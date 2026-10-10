/**
 * Share links: read-only links to one deck's committed history (ADR 0007). Only the
 * SHA-256 hash of a link's token is stored, and it never leaves this module: records
 * carry no hash, and lookups take the hash computed by the caller.
 *
 * A link can be used while it is not revoked, its deck is still tracked (untracking a
 * deck deletes its links) and the deck's owner (the user owning the deck's workspace) is
 * not disabled. Several links per deck are allowed, each labelled and revocable.
 *
 * Scoping: the owner's operations ({@link ShareLinkRepository.create},
 * {@link ShareLinkRepository.listForDeck}, {@link ShareLinkRepository.revoke}) only
 * reach decks of the context's workspace, so a deck or link of another workspace behaves
 * like one that does not exist. Resolving a token, finding links by the key their
 * creating session descends from, and revoking a whole workspace's links (account
 * recovery) are installation-wide: a token is its own authorization, keys belong to
 * users, not workspaces, and the auth service names the workspace explicitly.
 */
import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import { decks, shareLinks, users } from '@/server/db/schema';

import { batches, distinct, inWorkspace, referencing, type RepositoryContext } from './context';
import { RepositoryError } from './errors';

export interface ShareLinkRecord {
  id: string;
  deckId: string;
  /** The owner's name for the link ("For Mikko"). */
  label: string;
  /** Whether viewers see the owner's private version notes. */
  includeNotes: boolean;
  /** Who made the link (the deck's owner), or `null` when that user was removed. */
  createdByUserId: string | null;
  /** The bookmarklet key the creating session descends from, or `null`. */
  credentialId: string | null;
  createdAt: string;
  /** Last view through the link, recorded at most hourly; `null` before the first view. */
  lastViewedAt: string | null;
  revokedAt: string | null;
}

export interface NewShareLink {
  /** A deck of the context's workspace. */
  deckId: string;
  /** SHA-256 hex digest of the full link token. */
  tokenHash: string;
  /** Validated by the caller; stored as given. */
  label: string;
  includeNotes: boolean;
  createdByUserId: string;
  /** The bookmarklet key the creating session descends from, if any. */
  credentialId: string | null;
}

/**
 * A link that can be used, with what viewing through it needs. The deck is
 * `link.deckId`; its cached listing info (name, format) is deliberately not returned,
 * because it reflects the latest Moxfield state, which viewers must not see.
 */
export interface ActiveShareLink {
  link: ShareLinkRecord;
  /** The deck's workspace: the viewer scope reads history with repositories bound to it. */
  workspaceId: string;
  /** Display name of the deck's owner. */
  ownerDisplayName: string;
}

export interface ShareLinkRepository {
  /**
   * Creates a link to a deck of the context's workspace.
   * @throws {RepositoryError} `not-found` for a deck that is not in the workspace;
   * `conflict` when the token hash is already stored; `invalid-input` for an empty hash.
   */
  create(input: NewShareLink): ShareLinkRecord;
  /**
   * The link whose token hashes to `tokenHash`, when it can be used (see the module
   * comment); otherwise `null`. A revoked link, an untracked deck and a disabled owner are
   * indistinguishable from a token that never existed.
   */
  findActive(tokenHash: string): ActiveShareLink | null;
  /** Whether the link with this id can still be used (the conditions of {@link findActive}). */
  isActive(id: string): boolean;
  /** The links of a deck in the context's workspace that are not revoked, newest first. */
  listForDeck(deckId: string): ShareLinkRecord[];
  /**
   * Revokes a link of a deck in the context's workspace. Idempotent: revoking a revoked,
   * unknown or foreign link changes nothing.
   * @returns whether a link was revoked by this call.
   */
  revoke(deckId: string, id: string, at: string): boolean;
  /**
   * Records a view at `at`, unless a view was recorded at or after `since` (callers pass
   * `at` minus the recording interval, so busy links cost at most one write per interval).
   * @returns whether the view was recorded.
   */
  touchViewed(id: string, at: string, since: string): boolean;
  /**
   * The links `userId` made in sessions descending from one of `credentialIds` that are
   * not revoked, newest first. Links of other users are never returned.
   */
  listByCredential(userId: string, credentialIds: readonly string[]): ShareLinkRecord[];
  /**
   * Revokes the links {@link listByCredential} returns for the same arguments.
   * @returns how many were revoked.
   */
  revokeByCredential(userId: string, credentialIds: readonly string[], at: string): number;
  /**
   * Revokes every link to a deck of workspace `workspaceId` that is not revoked, whoever
   * made it and however (account recovery: nothing made before it can be trusted).
   * Installation-wide: `workspaceId` is named explicitly, not taken from the context.
   * @returns how many were revoked.
   */
  revokeAllForWorkspace(workspaceId: string, at: string): number;
}

/** Columns of a link record (everything except the token hash). */
const recordColumns = {
  id: shareLinks.id,
  deckId: shareLinks.deckId,
  label: shareLinks.label,
  includeNotes: shareLinks.includeNotes,
  createdByUserId: shareLinks.createdByUserId,
  credentialId: shareLinks.credentialId,
  createdAt: shareLinks.createdAt,
  lastViewedAt: shareLinks.lastViewedAt,
  revokedAt: shareLinks.revokedAt,
};

export function createShareLinkRepository(ctx: RepositoryContext): ShareLinkRepository {
  /**
   * The links matching `condition` that can be used: not revoked, joined to their deck
   * (which exists while it is tracked) and to the deck's owner, who must not be disabled.
   */
  const usable = (condition: SQL) =>
    ctx.db
      .select({
        link: recordColumns,
        workspaceId: decks.workspaceId,
        ownerDisplayName: users.displayName,
      })
      .from(shareLinks)
      .innerJoin(decks, eq(decks.id, shareLinks.deckId))
      .innerJoin(users, eq(users.workspaceId, decks.workspaceId))
      .where(and(condition, isNull(shareLinks.revokedAt), isNull(users.disabledAt)));

  return {
    create(input) {
      if (input.tokenHash === '')
        throw new RepositoryError('invalid-input', 'A share link needs a token hash');
      const deck = ctx.db
        .select({ id: decks.id })
        .from(decks)
        .where(and(eq(decks.id, input.deckId), eq(decks.workspaceId, ctx.workspaceId)))
        .get();
      if (!deck) throw new RepositoryError('not-found', `Deck ${input.deckId} does not exist`);
      const taken = ctx.db
        .select({ id: shareLinks.id })
        .from(shareLinks)
        .where(eq(shareLinks.tokenHash, input.tokenHash))
        .get();
      if (taken) throw new RepositoryError('conflict', 'A share link with this token already exists');
      return referencing(`Share link of deck ${input.deckId}`, () =>
        ctx.db
          .insert(shareLinks)
          .values({
            id: ctx.newId(),
            deckId: input.deckId,
            tokenHash: input.tokenHash,
            label: input.label,
            includeNotes: input.includeNotes,
            createdByUserId: input.createdByUserId,
            credentialId: input.credentialId,
            createdAt: ctx.now(),
          })
          .returning(recordColumns)
          .get(),
      );
    },

    findActive(tokenHash) {
      return usable(eq(shareLinks.tokenHash, tokenHash)).get() ?? null;
    },

    isActive(id) {
      return usable(eq(shareLinks.id, id)).get() !== undefined;
    },

    listForDeck(deckId) {
      return ctx.db
        .select(recordColumns)
        .from(shareLinks)
        .where(
          and(
            eq(shareLinks.deckId, deckId),
            isNull(shareLinks.revokedAt),
            inWorkspace(ctx, shareLinks.deckId),
          ),
        )
        .orderBy(desc(shareLinks.createdAt), desc(sql`${shareLinks}.rowid`))
        .all();
    },

    revoke(deckId, id, at) {
      const revoked = ctx.db
        .update(shareLinks)
        .set({ revokedAt: at })
        .where(
          and(
            eq(shareLinks.id, id),
            eq(shareLinks.deckId, deckId),
            isNull(shareLinks.revokedAt),
            inWorkspace(ctx, shareLinks.deckId),
          ),
        )
        .returning({ id: shareLinks.id })
        .all();
      return revoked.length > 0;
    },

    touchViewed(id, at, since) {
      const touched = ctx.db
        .update(shareLinks)
        .set({ lastViewedAt: at })
        .where(
          and(eq(shareLinks.id, id), or(isNull(shareLinks.lastViewedAt), lt(shareLinks.lastViewedAt, since))),
        )
        .returning({ id: shareLinks.id })
        .all();
      return touched.length > 0;
    },

    listByCredential(userId, credentialIds) {
      return batches(distinct(credentialIds))
        .flatMap((batch) =>
          ctx.db
            .select(recordColumns)
            .from(shareLinks)
            .where(
              and(
                eq(shareLinks.createdByUserId, userId),
                inArray(shareLinks.credentialId, batch),
                isNull(shareLinks.revokedAt),
              ),
            )
            .all(),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    revokeByCredential(userId, credentialIds, at) {
      let revoked = 0;
      for (const batch of batches(distinct(credentialIds))) {
        revoked += ctx.db
          .update(shareLinks)
          .set({ revokedAt: at })
          .where(
            and(
              eq(shareLinks.createdByUserId, userId),
              inArray(shareLinks.credentialId, batch),
              isNull(shareLinks.revokedAt),
            ),
          )
          .returning({ id: shareLinks.id })
          .all().length;
      }
      return revoked;
    },

    revokeAllForWorkspace(workspaceId, at) {
      return ctx.db
        .update(shareLinks)
        .set({ revokedAt: at })
        .where(
          and(
            isNull(shareLinks.revokedAt),
            inArray(
              shareLinks.deckId,
              ctx.db.select({ id: decks.id }).from(decks).where(eq(decks.workspaceId, workspaceId)),
            ),
          ),
        )
        .returning({ id: shareLinks.id })
        .all().length;
    },
  };
}
