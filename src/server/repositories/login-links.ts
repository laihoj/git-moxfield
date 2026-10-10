/**
 * Login links: one-time, expiring sign-in links for an existing user (ADR 0006).
 * `device` links are created by a signed-in user to sign in another device; `recovery`
 * links by an admin for a user who lost every key and device. Only the SHA-256 hash of
 * the link token is stored. Installation-wide (not scoped to the context's workspace).
 *
 * A link works once, until it expires, and only while nothing withdrew it: revoking it
 * (an admin, or its user signing out everywhere, being disabled or recovered), revoking
 * the bookmarklet key its creating session descends from, or (recovery links) its
 * creator no longer being an active admin. Used recovery links are kept: they are the
 * record a user sees of an admin's link signing in as them.
 */
import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';

import { credentials, loginLinks, users } from '@/server/db/schema';

import {
  isUniqueViolation,
  referencing,
  withTransaction,
  write,
  type LibsqlExecutor,
  type RepositoryContext,
} from './context';
import { RepositoryError } from './errors';
import type { UserRecord } from './users';

export type LoginLinkPurpose = (typeof loginLinks.$inferSelect)['purpose'];

export interface LoginLinkRecord {
  id: string;
  userId: string;
  purpose: LoginLinkPurpose;
  /** Who created the link (the user themselves, an admin, or `null` for the command line). */
  createdByUserId: string | null;
  /** The bookmarklet key the creating session descends from (`device` links), or `null`. */
  credentialId: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

export interface NewLoginLink {
  userId: string;
  /** SHA-256 hex digest of the full link token. */
  tokenHash: string;
  purpose: LoginLinkPurpose;
  createdByUserId: string | null;
  /** The bookmarklet key the creating session descends from, if any. */
  credentialId?: string | null;
  expiresAt: string;
}

/**
 * Which unused links {@link LoginLinkRepository.revokeUnused} withdraws: those matching
 * every given field. At least one of `userId`, `createdByUserId` and `credentialId` is
 * required, so no call can withdraw every link of the installation.
 */
export interface UnusedLinkFilter {
  /** Links that sign in this user. */
  userId?: string;
  /** Links this user made. */
  createdByUserId?: string;
  /** Links whose creating session descends from this key. */
  credentialId?: string;
  purpose?: LoginLinkPurpose;
}

export interface LoginLinkRepository {
  /**
   * @throws {RepositoryError} `not-found` for an unknown user; `conflict` when the token
   * hash is already stored.
   */
  create(input: NewLoginLink): Promise<LoginLinkRecord>;
  /** The link with this token hash in any state (used, expired, revoked), or `null`. */
  getByTokenHash(tokenHash: string): Promise<LoginLinkRecord | null>;
  /**
   * Uses up a link: marks it used when it is unused, not revoked, has not expired at
   * `now`, its user is not disabled, the key it descends from (if any) is not revoked,
   * and, for a recovery link made by an admin, that admin is still an active admin. The
   * check and the update are one conditional `UPDATE` in an `IMMEDIATE` transaction, so of
   * concurrent consumers (other requests, other processes) exactly one succeeds.
   * @returns the link and its user, or `null` when the link cannot be used.
   */
  consume(tokenHash: string, now: string): Promise<{ link: LoginLinkRecord; user: UserRecord } | null>;
  /**
   * Whether the link's creator, if it is a recovery link made by an admin, is still an
   * active admin (as {@link consume} requires). `true` for every other link.
   */
  hasActiveCreator(link: LoginLinkRecord): Promise<boolean>;
  /**
   * Withdraws one link that is unused, not revoked and not expired at `at` (and, with
   * `purpose`, has that purpose). @returns whether one was withdrawn.
   */
  revoke(id: string, at: string, options?: { purpose?: LoginLinkPurpose }): Promise<boolean>;
  /**
   * Withdraws every link matching `filter` that is unused, not revoked and not expired
   * at `at`. @returns how many were withdrawn.
   * @throws {RepositoryError} `invalid-input` when `filter` names no user or key.
   */
  revokeUnused(filter: UnusedLinkFilter, at: string): Promise<number>;
  /** Links of `purpose` that are unused, not revoked and not expired at `now`, newest first. */
  listPending(purpose: LoginLinkPurpose, now: string): Promise<LoginLinkRecord[]>;
  /** The user's used links of `purpose`, most recently used first. */
  listUsedForUser(userId: string, purpose: LoginLinkPurpose): Promise<LoginLinkRecord[]>;
}

const recordColumns = {
  id: loginLinks.id,
  userId: loginLinks.userId,
  purpose: loginLinks.purpose,
  createdByUserId: loginLinks.createdByUserId,
  credentialId: loginLinks.credentialId,
  createdAt: loginLinks.createdAt,
  expiresAt: loginLinks.expiresAt,
  usedAt: loginLinks.usedAt,
  revokedAt: loginLinks.revokedAt,
};

/** `id IN (active admins)`: admins who are not disabled. */
function activeAdminIds(db: LibsqlExecutor) {
  return db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)));
}

/** A link that is neither used nor revoked and has not expired at `now`. */
function isPending(now: string): SQL | undefined {
  return and(isNull(loginLinks.usedAt), isNull(loginLinks.revokedAt), gt(loginLinks.expiresAt, now));
}

export function createLoginLinkRepository(ctx: RepositoryContext): LoginLinkRepository {
  const duplicate = (cause?: unknown): RepositoryError =>
    new RepositoryError(
      'conflict',
      'A login link with this token already exists',
      cause === undefined ? undefined : { cause },
    );

  return {
    async create(input) {
      const taken = await ctx.db
        .select({ id: loginLinks.id })
        .from(loginLinks)
        .where(eq(loginLinks.tokenHash, input.tokenHash))
        .get();
      if (taken) throw duplicate();
      const values = {
        id: ctx.newId(),
        tokenHash: input.tokenHash,
        userId: input.userId,
        purpose: input.purpose,
        createdByUserId: input.createdByUserId,
        credentialId: input.credentialId ?? null,
        createdAt: ctx.now(),
        expiresAt: input.expiresAt,
      };
      try {
        return await referencing(`Login link of user ${input.userId}`, () =>
          write(ctx, (db) => db.insert(loginLinks).values(values).returning(recordColumns).get()),
        );
      } catch (error) {
        // The same token hash stored since the check above.
        if (isUniqueViolation(error)) throw duplicate(error);
        throw error;
      }
    },

    async getByTokenHash(tokenHash) {
      const row = await ctx.db
        .select(recordColumns)
        .from(loginLinks)
        .where(eq(loginLinks.tokenHash, tokenHash))
        .get();
      return row ?? null;
    },

    consume(tokenHash, now) {
      return withTransaction(ctx, async ({ db }) => {
        // `undefined` when no row matched (Drizzle's type omits that case).
        const link = (await db
          .update(loginLinks)
          .set({ usedAt: now })
          .where(
            and(
              eq(loginLinks.tokenHash, tokenHash),
              isPending(now),
              inArray(
                loginLinks.userId,
                db.select({ id: users.id }).from(users).where(isNull(users.disabledAt)),
              ),
              or(
                isNull(loginLinks.credentialId),
                inArray(
                  loginLinks.credentialId,
                  db.select({ id: credentials.id }).from(credentials).where(isNull(credentials.revokedAt)),
                ),
              ),
              // A recovery link stops working when its admin does (`null`: the command line).
              or(
                eq(loginLinks.purpose, 'device'),
                isNull(loginLinks.createdByUserId),
                inArray(loginLinks.createdByUserId, activeAdminIds(db)),
              ),
            ),
          )
          .returning(recordColumns)
          .get()) as LoginLinkRecord | undefined;
        if (!link) return null;
        const user = await db.select().from(users).where(eq(users.id, link.userId)).get();
        if (!user) throw new RepositoryError('corrupt-data', `Login link ${link.id} has no user`);
        return { link, user };
      });
    },

    async hasActiveCreator(link) {
      if (link.purpose !== 'recovery' || link.createdByUserId === null) return true;
      const creator = await ctx.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, link.createdByUserId), eq(users.role, 'admin'), isNull(users.disabledAt)))
        .get();
      return creator !== undefined;
    },

    async revoke(id, at, options = {}) {
      const result = await write(ctx, (db) =>
        db
          .update(loginLinks)
          .set({ revokedAt: at })
          .where(
            and(
              eq(loginLinks.id, id),
              isPending(at),
              options.purpose === undefined ? undefined : eq(loginLinks.purpose, options.purpose),
            ),
          ),
      );
      return result.rowsAffected > 0;
    },

    async revokeUnused(filter, at) {
      if (
        filter.userId === undefined &&
        filter.createdByUserId === undefined &&
        filter.credentialId === undefined
      ) {
        throw new RepositoryError('invalid-input', 'Name the user or key whose links to revoke');
      }
      const result = await write(ctx, (db) =>
        db
          .update(loginLinks)
          .set({ revokedAt: at })
          .where(
            and(
              isPending(at),
              filter.userId === undefined ? undefined : eq(loginLinks.userId, filter.userId),
              filter.createdByUserId === undefined
                ? undefined
                : eq(loginLinks.createdByUserId, filter.createdByUserId),
              filter.credentialId === undefined
                ? undefined
                : eq(loginLinks.credentialId, filter.credentialId),
              filter.purpose === undefined ? undefined : eq(loginLinks.purpose, filter.purpose),
            ),
          ),
      );
      return result.rowsAffected;
    },

    listPending(purpose, now) {
      return ctx.db
        .select(recordColumns)
        .from(loginLinks)
        .where(and(eq(loginLinks.purpose, purpose), isPending(now)))
        .orderBy(desc(loginLinks.createdAt), desc(sql`${loginLinks}.rowid`))
        .all();
    },

    listUsedForUser(userId, purpose) {
      return ctx.db
        .select(recordColumns)
        .from(loginLinks)
        .where(
          and(eq(loginLinks.userId, userId), eq(loginLinks.purpose, purpose), isNotNull(loginLinks.usedAt)),
        )
        .orderBy(desc(loginLinks.usedAt), desc(sql`${loginLinks}.rowid`))
        .all();
    },
  };
}
