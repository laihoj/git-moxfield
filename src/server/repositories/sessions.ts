/**
 * Sessions: signed-in browsers (ADR 0006). The browser's cookie holds the session token;
 * only the SHA-256 hash of the token is stored, and records never carry it.
 *
 * A session is active while it is neither revoked nor expired, is not a pending
 * hand-off, and its user is not disabled. Expiry slides (see the auth service);
 * revocation is permanent. Timestamps are ISO-8601 UTC strings of one format, so they
 * compare correctly as text. Installation-wide (not scoped to the context's workspace).
 *
 * A **pending hand-off** is a session row the same-tab bookmarklet's cross-site post
 * starts (`pendingHandoff`): it signs nobody in, and is found only by
 * {@link SessionRepository.findPendingHandoffByTokenHash}, until the browser completes
 * the hand-off ({@link SessionRepository.promoteHandoff}) or it is revoked or expires.
 */
import { and, desc, eq, gt, isNull, ne, sql, type SQL } from 'drizzle-orm';

import { credentials, sessions, users } from '@/server/db/schema';

import { allOf, insertWithUniqueHash, updateRows, type RepositoryContext } from './context';
import { credentialRecordColumns, type CredentialRecord } from './credentials';
import type { UserRecord } from './users';

/** How a session started: which credential or one-time link signed the browser in. */
export type SessionOrigin = (typeof sessions.$inferSelect)['createdVia'];

export interface SessionRecord {
  id: string;
  userId: string;
  createdVia: SessionOrigin;
  /**
   * The bookmarklet key the session descends from: the key that signed the browser in, or
   * for a device-link session the key of the session that made the link (`null` when it
   * descends from no key: invite, claim, recovery).
   */
  credentialId: string | null;
  /** Truncated User-Agent, to recognize the device. */
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface NewSession {
  userId: string;
  /** SHA-256 hex digest of the full session token. */
  tokenHash: string;
  createdVia: SessionOrigin;
  credentialId?: string | null;
  userAgent?: string | null;
  expiresAt: string;
  /** Starts a pending hand-off instead of a session (see the module comment). */
  pendingHandoff?: boolean;
}

/** A pending hand-off with its user and the bookmarklet key that started it. */
export interface PendingHandoff {
  session: SessionRecord;
  user: UserRecord;
  credential: CredentialRecord;
}

export interface SessionRepository {
  /**
   * Starts a session.
   * @throws {RepositoryError} `not-found` for an unknown user or credential;
   * `conflict` when the token hash is already stored.
   */
  create(input: NewSession): Promise<SessionRecord>;
  /**
   * The session with this token hash and its user, when the session is not revoked, has
   * not expired at `now`, is not a pending hand-off and the user is not disabled;
   * otherwise `null`.
   */
  findActiveByTokenHash(
    tokenHash: string,
    now: string,
  ): Promise<{ session: SessionRecord; user: UserRecord } | null>;
  /** One of `userId`'s sessions that is active at `now` (as {@link findActiveByTokenHash}), or `null`. */
  getActive(userId: string, sessionId: string, now: string): Promise<SessionRecord | null>;
  /**
   * The pending hand-off with this token hash, when it is not revoked, has not expired at
   * `now`, its user is not disabled and the key that started it is not revoked;
   * otherwise `null`.
   */
  findPendingHandoffByTokenHash(tokenHash: string, now: string): Promise<PendingHandoff | null>;
  /**
   * Turns a pending hand-off into an ordinary session expiring at `expiresAt`. One
   * conditional `UPDATE`: of concurrent promotions exactly one succeeds, and a revoked or
   * expired hand-off is never promoted.
   * @returns whether the hand-off was promoted.
   */
  promoteHandoff(id: string, now: string, expiresAt: string): Promise<boolean>;
  /** Revokes the pending hand-off with this token hash (never an ordinary session). */
  revokePendingHandoff(tokenHash: string, at: string): Promise<boolean>;
  /** Records activity and, when given, a new expiry. Revoked sessions are left alone. */
  touch(id: string, update: { lastSeenAt: string; expiresAt?: string }): Promise<void>;
  /** The user's sessions that are active at `now` (no pending hand-offs), most recently seen first. */
  listActiveForUser(userId: string, now: string): Promise<SessionRecord[]>;
  /**
   * Revokes one of `userId`'s sessions; another user's session is never touched.
   * @returns whether a session that was not revoked yet got revoked.
   */
  revoke(userId: string, sessionId: string, at: string): Promise<boolean>;
  /** Revokes the session with this token hash (signing out). Returns whether one was revoked. */
  revokeByTokenHash(tokenHash: string, at: string): Promise<boolean>;
  /**
   * Revokes the user's sessions (pending hand-offs included) that are not revoked yet:
   * all of them, or with `credentialId` only those that descend from that credential;
   * `exceptSessionId` survives.
   * @returns the number of sessions revoked.
   */
  revokeAllForUser(
    userId: string,
    at: string,
    options?: { exceptSessionId?: string; credentialId?: string },
  ): Promise<number>;
}

/** Columns of a session record (everything except the token hash). */
const recordColumns = {
  id: sessions.id,
  userId: sessions.userId,
  createdVia: sessions.createdVia,
  credentialId: sessions.credentialId,
  userAgent: sessions.userAgent,
  createdAt: sessions.createdAt,
  lastSeenAt: sessions.lastSeenAt,
  expiresAt: sessions.expiresAt,
  revokedAt: sessions.revokedAt,
};

/** A session (or pending hand-off, with `pendingHandoff`) that is not revoked and has not expired at `now`. */
function liveSession(now: string, pendingHandoff: boolean): SQL {
  return allOf(
    isNull(sessions.revokedAt),
    gt(sessions.expiresAt, now),
    eq(sessions.pendingHandoff, pendingHandoff),
  );
}

export function createSessionRepository(ctx: RepositoryContext): SessionRepository {
  return {
    create(input) {
      return insertWithUniqueHash(ctx, {
        hashColumn: sessions.tokenHash,
        hash: input.tokenHash,
        emptyHashMessage: 'A session needs a token hash',
        duplicateMessage: 'A session with this token already exists',
        references: `Session of user ${input.userId}`,
        values: () => {
          const now = ctx.now();
          return {
            id: ctx.newId(),
            userId: input.userId,
            tokenHash: input.tokenHash,
            createdVia: input.createdVia,
            credentialId: input.credentialId ?? null,
            pendingHandoff: input.pendingHandoff ?? false,
            userAgent: input.userAgent ?? null,
            createdAt: now,
            lastSeenAt: now,
            expiresAt: input.expiresAt,
          };
        },
        insert: (db, values) => db.insert(sessions).values(values).returning(recordColumns).get(),
      });
    },

    async findActiveByTokenHash(tokenHash, now) {
      const row = await ctx.db
        .select({ session: recordColumns, user: users })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.tokenHash, tokenHash), liveSession(now, false), isNull(users.disabledAt)))
        .get();
      return row ?? null;
    },

    async getActive(userId, sessionId, now) {
      const row = await ctx.db
        .select(recordColumns)
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            eq(sessions.id, sessionId),
            eq(sessions.userId, userId),
            liveSession(now, false),
            isNull(users.disabledAt),
          ),
        )
        .get();
      return row ?? null;
    },

    async findPendingHandoffByTokenHash(tokenHash, now) {
      const row = await ctx.db
        .select({
          session: recordColumns,
          user: users,
          credential: credentialRecordColumns,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .innerJoin(
          credentials,
          and(eq(credentials.id, sessions.credentialId), eq(credentials.userId, users.id)),
        )
        .where(
          and(
            eq(sessions.tokenHash, tokenHash),
            liveSession(now, true),
            isNull(users.disabledAt),
            isNull(credentials.revokedAt),
          ),
        )
        .get();
      return row ?? null;
    },

    async promoteHandoff(id, now, expiresAt) {
      const changed = await updateRows(
        ctx,
        sessions,
        { pendingHandoff: false, expiresAt, lastSeenAt: now },
        and(eq(sessions.id, id), liveSession(now, true)),
      );
      return changed > 0;
    },

    async revokePendingHandoff(tokenHash, at) {
      const changed = await updateRows(
        ctx,
        sessions,
        { revokedAt: at },
        and(eq(sessions.tokenHash, tokenHash), eq(sessions.pendingHandoff, true), isNull(sessions.revokedAt)),
      );
      return changed > 0;
    },

    async touch(id, change) {
      await updateRows(
        ctx,
        sessions,
        change.expiresAt === undefined
          ? { lastSeenAt: change.lastSeenAt }
          : { lastSeenAt: change.lastSeenAt, expiresAt: change.expiresAt },
        and(eq(sessions.id, id), isNull(sessions.revokedAt)),
      );
    },

    listActiveForUser(userId, now) {
      return ctx.db
        .select(recordColumns)
        .from(sessions)
        .where(and(eq(sessions.userId, userId), liveSession(now, false)))
        .orderBy(desc(sessions.lastSeenAt), desc(sessions.createdAt), desc(sql`${sessions}.rowid`))
        .all();
    },

    async revoke(userId, sessionId, at) {
      const changed = await updateRows(
        ctx,
        sessions,
        { revokedAt: at },
        and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)),
      );
      return changed > 0;
    },

    async revokeByTokenHash(tokenHash, at) {
      const changed = await updateRows(
        ctx,
        sessions,
        { revokedAt: at },
        and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)),
      );
      return changed > 0;
    },

    revokeAllForUser(userId, at, options = {}) {
      return updateRows(
        ctx,
        sessions,
        { revokedAt: at },
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          options.credentialId === undefined ? undefined : eq(sessions.credentialId, options.credentialId),
          options.exceptSessionId === undefined ? undefined : ne(sessions.id, options.exceptSessionId),
        ),
      );
    },
  };
}
