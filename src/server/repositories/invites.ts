/**
 * Invites: one-time, expiring links that create a new user (ADR 0006). Created by an
 * admin (or from the command line), used by the friend who picks a display name. Only
 * the SHA-256 hash of the invite token is stored. Installation-wide (not scoped to the
 * context's workspace).
 *
 * An invite works only while the admin who made it is an active admin: disabling an
 * admin withdraws their pending invites, and acceptance re-checks the creator, so a
 * disabled admin's invite can never bring them back.
 */
import { and, desc, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

import type { UserRole } from '@/core/roles';
import { invites } from '@/server/db/schema';

import { allOf, insertWithUniqueHash, updateRows, withTransaction, type RepositoryContext } from './context';
import {
  activeAdminIds,
  insertUserAdoptingWorkspace,
  insertUserWithWorkspace,
  isActiveAdmin,
  requireDisplayName,
  type UserRecord,
} from './users';

export interface InviteRecord {
  id: string;
  /** Role the new user gets. */
  role: UserRole;
  /** Who the invite is for, as a reminder for the admin. */
  note: string;
  /** `null` for invites created from the command line (or whose creator was removed). */
  createdByUserId: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedByUserId: string | null;
  revokedAt: string | null;
}

export interface NewInvite {
  /** SHA-256 hex digest of the full invite token. */
  tokenHash: string;
  role: UserRole;
  note: string;
  createdByUserId: string | null;
  expiresAt: string;
}

export interface InviteRepository {
  /**
   * @throws {RepositoryError} `not-found` for an unknown creator; `conflict` when the
   * token hash is already stored.
   */
  create(input: NewInvite): Promise<InviteRecord>;
  getById(id: string): Promise<InviteRecord | null>;
  /** The invite with this token hash in any state, or `null`. */
  getByTokenHash(tokenHash: string): Promise<InviteRecord | null>;
  /** Every invite, newest first. */
  list(): Promise<InviteRecord[]>;
  /**
   * Uses up an invite and creates its user, atomically: one `IMMEDIATE` transaction marks
   * the invite used (a conditional `UPDATE` that only matches an unused, unrevoked invite that has
   * not expired at `now` and whose creator, unless it is the command line, is an active
   * admin), creates the user with the invite's role and a workspace of its own (or, with
   * `adoptWorkspaceId`, owning that existing, unowned workspace), and records who used
   * it. Of concurrent acceptances exactly one succeeds; the others get `null` and nothing
   * is created for them.
   * @throws {RepositoryError} `invalid-input` for an empty display name; `conflict` when
   * the workspace to adopt has an owner (nothing changes in either case).
   */
  accept(
    tokenHash: string,
    now: string,
    user: { displayName: string; adoptWorkspaceId?: string },
  ): Promise<{ invite: InviteRecord; user: UserRecord } | null>;
  /**
   * Revokes an invite that is neither used nor revoked yet.
   * @returns whether the invite was revoked.
   */
  revoke(id: string, at: string): Promise<boolean>;
  /**
   * Revokes every invite `userId` made that is unused, not revoked and not expired at
   * `at`. @returns how many were revoked.
   */
  revokePendingCreatedBy(userId: string, at: string): Promise<number>;
  /** Whether the invite's creator is an active admin (always `true` for the command line). */
  hasActiveCreator(invite: InviteRecord): Promise<boolean>;
}

const recordColumns = {
  id: invites.id,
  role: invites.role,
  note: invites.note,
  createdByUserId: invites.createdByUserId,
  createdAt: invites.createdAt,
  expiresAt: invites.expiresAt,
  usedAt: invites.usedAt,
  usedByUserId: invites.usedByUserId,
  revokedAt: invites.revokedAt,
};

/** An invite that is neither used nor revoked and has not expired at `now`. */
function pendingInvite(now: string): SQL {
  return allOf(isNull(invites.usedAt), isNull(invites.revokedAt), gt(invites.expiresAt, now));
}

export function createInviteRepository(ctx: RepositoryContext): InviteRepository {
  return {
    create(input) {
      return insertWithUniqueHash(ctx, {
        hashColumn: invites.tokenHash,
        hash: input.tokenHash,
        emptyHashMessage: 'An invite needs a token hash',
        duplicateMessage: 'An invite with this token already exists',
        references: 'Invite',
        values: () => ({
          id: ctx.newId(),
          tokenHash: input.tokenHash,
          role: input.role,
          note: input.note.trim(),
          createdByUserId: input.createdByUserId,
          createdAt: ctx.now(),
          expiresAt: input.expiresAt,
        }),
        insert: (db, values) => db.insert(invites).values(values).returning(recordColumns).get(),
      });
    },

    async getById(id) {
      const row = await ctx.db.select(recordColumns).from(invites).where(eq(invites.id, id)).get();
      return row ?? null;
    },

    async getByTokenHash(tokenHash) {
      const row = await ctx.db
        .select(recordColumns)
        .from(invites)
        .where(eq(invites.tokenHash, tokenHash))
        .get();
      return row ?? null;
    },

    list() {
      return ctx.db
        .select(recordColumns)
        .from(invites)
        .orderBy(desc(invites.createdAt), desc(sql`${invites}.rowid`))
        .all();
    },

    async accept(tokenHash, now, user) {
      requireDisplayName(user.displayName);
      return withTransaction(ctx, async (tx) => {
        // `undefined` when no row matched (Drizzle's type omits that case).
        const claimed = (await tx.db
          .update(invites)
          .set({ usedAt: now })
          .where(
            and(
              eq(invites.tokenHash, tokenHash),
              pendingInvite(now),
              or(isNull(invites.createdByUserId), inArray(invites.createdByUserId, activeAdminIds(tx.db))),
            ),
          )
          .returning(recordColumns)
          .get()) as InviteRecord | undefined;
        if (!claimed) return null;
        const created =
          user.adoptWorkspaceId === undefined
            ? await insertUserWithWorkspace(tx, { displayName: user.displayName, role: claimed.role })
            : await insertUserAdoptingWorkspace(tx, {
                displayName: user.displayName,
                role: claimed.role,
                workspaceId: user.adoptWorkspaceId,
              });
        const invite = await tx.db
          .update(invites)
          .set({ usedByUserId: created.id })
          .where(eq(invites.id, claimed.id))
          .returning(recordColumns)
          .get();
        return { invite, user: created };
      });
    },

    async revoke(id, at) {
      const changed = await updateRows(
        ctx,
        invites,
        { revokedAt: at },
        and(eq(invites.id, id), isNull(invites.usedAt), isNull(invites.revokedAt)),
      );
      return changed > 0;
    },

    revokePendingCreatedBy(userId, at) {
      return updateRows(
        ctx,
        invites,
        { revokedAt: at },
        and(eq(invites.createdByUserId, userId), pendingInvite(at)),
      );
    },

    async hasActiveCreator(invite) {
      return invite.createdByUserId === null || (await isActiveAdmin(ctx.db, invite.createdByUserId));
    },
  };
}
