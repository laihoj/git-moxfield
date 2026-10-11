/**
 * Credentials: ways for a user to prove who they are (ADR 0006). Today only
 * `bookmarklet-key`, a high-entropy secret embedded in the user's bookmarklet; `oauth`
 * credentials attach to the same user later.
 *
 * Only the SHA-256 hash of a secret is stored, and it never leaves this module: records
 * carry no hash, and lookups take the hash computed by the caller. Installation-wide
 * (not scoped to the context's workspace).
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { credentials, users } from '@/server/db/schema';

import { insertWithUniqueHash, updateRows, type RepositoryContext } from './context';
import { RepositoryError } from './errors';
import type { UserRecord } from './users';

export type CredentialKind = (typeof credentials.$inferSelect)['kind'];

export interface CredentialRecord {
  id: string;
  userId: string;
  kind: CredentialKind;
  /** Human label, e.g. "Laptop Chrome". */
  label: string;
  /**
   * The key the session that made this one descends from (a key made in a browser that
   * another key signed in), or `null`.
   */
  createdByCredentialId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface NewBookmarkletKey {
  userId: string;
  label: string;
  /** SHA-256 hex digest of the full key string. */
  secretHash: string;
  /** The key the creating session descends from (one of the same user's keys), if any. */
  createdByCredentialId?: string | null;
}

export interface CredentialRepository {
  /**
   * Stores a bookmarklet key by the hash of its secret.
   * @throws {RepositoryError} `not-found` for an unknown user; `conflict` when the hash
   * is already stored; `invalid-input` for an empty label or hash.
   */
  createKey(input: NewBookmarkletKey): Promise<CredentialRecord>;
  /**
   * The credential whose secret hashes to `secretHash`, with its user, when the
   * credential is not revoked and the user is not disabled; otherwise `null`.
   */
  findActiveBySecretHash(
    secretHash: string,
  ): Promise<{ credential: CredentialRecord; user: UserRecord } | null>;
  /** The user's credentials, newest first; revoked ones only with `includeRevoked`. */
  listForUser(userId: string, options?: { includeRevoked?: boolean }): Promise<CredentialRecord[]>;
  /**
   * Revokes one of `userId`'s credentials. Another user's credential is never touched.
   * @returns whether an active credential was revoked.
   */
  revoke(userId: string, credentialId: string, at: string): Promise<boolean>;
  /** Revokes every active credential of the user. @returns how many were revoked. */
  revokeAllForUser(userId: string, at: string): Promise<number>;
  /** Records a use of the credential at `at`. */
  touchLastUsed(id: string, at: string): Promise<void>;
}

/** Columns of a credential record (everything except the secret hash and provider ids). */
export const credentialRecordColumns = {
  id: credentials.id,
  userId: credentials.userId,
  kind: credentials.kind,
  label: credentials.label,
  createdByCredentialId: credentials.createdByCredentialId,
  createdAt: credentials.createdAt,
  lastUsedAt: credentials.lastUsedAt,
  revokedAt: credentials.revokedAt,
};

export function createCredentialRepository(ctx: RepositoryContext): CredentialRepository {
  return {
    createKey(input) {
      const label = input.label.trim();
      if (label === '') throw new RepositoryError('invalid-input', 'A key needs a label');
      return insertWithUniqueHash(ctx, {
        hashColumn: credentials.secretHash,
        hash: input.secretHash,
        emptyHashMessage: 'A key needs a secret hash',
        duplicateMessage: 'A credential with this secret already exists',
        references: `Key of user ${input.userId}`,
        values: () => ({
          id: ctx.newId(),
          userId: input.userId,
          kind: 'bookmarklet-key' as const,
          secretHash: input.secretHash,
          label,
          createdByCredentialId: input.createdByCredentialId ?? null,
          createdAt: ctx.now(),
        }),
        insert: (db, values) =>
          db.insert(credentials).values(values).returning(credentialRecordColumns).get(),
      });
    },

    async findActiveBySecretHash(secretHash) {
      const row = await ctx.db
        .select({ credential: credentialRecordColumns, user: users })
        .from(credentials)
        .innerJoin(users, eq(users.id, credentials.userId))
        .where(
          and(
            eq(credentials.secretHash, secretHash),
            isNull(credentials.revokedAt),
            isNull(users.disabledAt),
          ),
        )
        .get();
      return row ?? null;
    },

    listForUser(userId, options = {}) {
      return ctx.db
        .select(credentialRecordColumns)
        .from(credentials)
        .where(
          and(
            eq(credentials.userId, userId),
            options.includeRevoked === true ? undefined : isNull(credentials.revokedAt),
          ),
        )
        .orderBy(desc(credentials.createdAt), desc(sql`${credentials}.rowid`))
        .all();
    },

    async revoke(userId, credentialId, at) {
      const changed = await updateRows(
        ctx,
        credentials,
        { revokedAt: at },
        and(eq(credentials.id, credentialId), eq(credentials.userId, userId), isNull(credentials.revokedAt)),
      );
      return changed > 0;
    },

    revokeAllForUser(userId, at) {
      return updateRows(
        ctx,
        credentials,
        { revokedAt: at },
        and(eq(credentials.userId, userId), isNull(credentials.revokedAt)),
      );
    },

    async touchLastUsed(id, at) {
      await updateRows(ctx, credentials, { lastUsedAt: at }, eq(credentials.id, id));
    },
  };
}
