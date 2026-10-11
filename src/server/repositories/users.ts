/**
 * Users: people with an account on this installation (ADR 0006). A user owns exactly one
 * workspace, created together with the user, and proves who they are with credentials
 * (`./credentials`), sessions and one-time links, which live in their own tables.
 *
 * Installation-wide (not scoped to the context's workspace). Display names are validated
 * by the auth service; this layer only rejects empty ones.
 */
import { and, asc, count, eq, isNull, sql, type SQL } from 'drizzle-orm';

import type { UserRole } from '@/core/roles';
import { users, workspaces } from '@/server/db/schema';

import {
  allOf,
  withTransaction,
  write,
  writeAll,
  type LibsqlExecutor,
  type RepositoryContext,
} from './context';
import { RepositoryError } from './errors';
import { newWorkspaceRow } from './workspaces';

export type { UserRole };

export type UserRecord = typeof users.$inferSelect;

/** A user as listed for admins. */
export interface UserListItem extends UserRecord {
  /** Decks tracked in the user's workspace. */
  deckCount: number;
  /** Bookmarklet keys (and other credentials) that are not revoked. */
  activeKeyCount: number;
}

export interface NewUser {
  displayName: string;
  role: UserRole;
}

/** `role = 'admin' AND disabled_at IS NULL`: an admin who is not disabled. */
export const activeAdmin: SQL = allOf(eq(users.role, 'admin'), isNull(users.disabledAt));

/** `SELECT id FROM users WHERE <active admin>`, for `id IN (...)`. */
export function activeAdminIds(db: LibsqlExecutor) {
  return db.select({ id: users.id }).from(users).where(activeAdmin);
}

/** Whether the user with this id exists and is an admin who is not disabled. */
export async function isActiveAdmin(db: LibsqlExecutor, userId: string): Promise<boolean> {
  const row = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), activeAdmin))
    .get();
  return row !== undefined;
}

/** Whether the record is an admin who is not disabled (the in-memory twin of {@link activeAdmin}). */
export function isActiveAdminRecord(user: Pick<UserRecord, 'role' | 'disabledAt'>): boolean {
  return user.role === 'admin' && user.disabledAt === null;
}

export interface UserRepository {
  /**
   * Creates a user together with a new workspace of its own, atomically.
   * @throws {RepositoryError} `invalid-input` for an empty display name.
   */
  create(input: NewUser): Promise<UserRecord>;
  /**
   * Creates a user who adopts an existing workspace without an owner (the first admin
   * adopting `local`, so a single-user installation keeps its history). Atomic.
   * @throws {RepositoryError} `not-found` for an unknown workspace; `conflict` when the
   * workspace already has an owner; `invalid-input` for an empty display name.
   */
  createForWorkspace(input: NewUser & { workspaceId: string }): Promise<UserRecord>;
  getById(id: string): Promise<UserRecord | null>;
  /** The owner of a workspace, or `null` for an unowned (or unknown) workspace. */
  getByWorkspaceId(workspaceId: string): Promise<UserRecord | null>;
  /** Users whose display name equals `name` ignoring case (names are not unique), oldest first. */
  findByDisplayName(name: string): Promise<UserRecord[]>;
  /** Number of users, disabled ones included. */
  count(): Promise<number>;
  /** Number of admins who are not disabled. */
  countActiveAdmins(): Promise<number>;
  /** Every user, oldest first (ties in creation order), with deck and active key counts. */
  list(): Promise<UserListItem[]>;
  /** @throws {RepositoryError} `not-found` for an unknown user; `invalid-input` for an empty name. */
  rename(id: string, displayName: string): Promise<UserRecord>;
  /**
   * Disables a user (keeping the first `disabledAt`) or enables them again.
   * @throws {RepositoryError} `not-found` for an unknown user.
   */
  setDisabled(id: string, disabled: boolean): Promise<UserRecord>;
  /** Records activity at `at`. Unknown users are ignored. */
  touchLastSeen(id: string, at: string): Promise<void>;
}

export function createUserRepository(ctx: RepositoryContext): UserRepository {
  const requireUser = async (db: LibsqlExecutor, id: string): Promise<UserRecord> => {
    const row = await db.select().from(users).where(eq(users.id, id)).get();
    if (!row) throw new RepositoryError('not-found', `User ${id} does not exist`);
    return row;
  };

  return {
    async create(input) {
      requireDisplayName(input.displayName);
      return insertUserWithWorkspace(ctx, input);
    },

    async createForWorkspace(input) {
      requireDisplayName(input.displayName);
      return withTransaction(ctx, (tx) => insertUserAdoptingWorkspace(tx, input));
    },

    async getById(id) {
      const row = await ctx.db.select().from(users).where(eq(users.id, id)).get();
      return row ?? null;
    },

    async getByWorkspaceId(workspaceId) {
      const row = await ctx.db.select().from(users).where(eq(users.workspaceId, workspaceId)).get();
      return row ?? null;
    },

    async findByDisplayName(name) {
      const wanted = foldName(name);
      if (wanted === '') return [];
      const rows = await ctx.db
        .select()
        .from(users)
        .orderBy(asc(users.createdAt), asc(sql`${users}.rowid`))
        .all();
      return rows.filter((user) => foldName(user.displayName) === wanted);
    },

    async count() {
      const row = await ctx.db.select({ n: count() }).from(users).get();
      return row?.n ?? 0;
    },

    async countActiveAdmins() {
      const row = await ctx.db.select({ n: count() }).from(users).where(activeAdmin).get();
      return row?.n ?? 0;
    },

    async list() {
      const rows = await ctx.db
        .select({
          user: users,
          // Written out with aliases: Drizzle renders columns in a `sql` template without
          // their table, which inside a subquery would compare a table's column with itself.
          deckCount: sql<number>`(SELECT COUNT(*) FROM "decks" AS "d" WHERE "d"."workspace_id" = "users"."workspace_id")`,
          activeKeyCount: sql<number>`(SELECT COUNT(*) FROM "credentials" AS "c" WHERE "c"."user_id" = "users"."id" AND "c"."revoked_at" IS NULL)`,
        })
        .from(users)
        .orderBy(asc(users.createdAt), asc(sql`${users}.rowid`))
        .all();
      return rows.map((row) => ({
        ...row.user,
        deckCount: row.deckCount,
        activeKeyCount: row.activeKeyCount,
      }));
    },

    async rename(id, displayName) {
      const name = requireDisplayName(displayName);
      return withTransaction(ctx, async ({ db }) => {
        await requireUser(db, id);
        return db
          .update(users)
          .set({ displayName: name, updatedAt: ctx.now() })
          .where(eq(users.id, id))
          .returning()
          .get();
      });
    },

    setDisabled(id, disabled) {
      return withTransaction(ctx, async ({ db }) => {
        const user = await requireUser(db, id);
        if ((user.disabledAt !== null) === disabled) return user;
        const now = ctx.now();
        return db
          .update(users)
          .set({ disabledAt: disabled ? now : null, updatedAt: now })
          .where(eq(users.id, id))
          .returning()
          .get();
      });
    },

    async touchLastSeen(id, at) {
      await write(ctx, (db) => db.update(users).set({ lastSeenAt: at }).where(eq(users.id, id)));
    },
  };
}

/**
 * Inserts a user and a new workspace of its own, atomically: one batch with the root
 * database, a savepoint inside a transaction. Shared with `./invites`, which creates the
 * user in the same transaction that uses up the invite.
 */
export async function insertUserWithWorkspace(ctx: RepositoryContext, input: NewUser): Promise<UserRecord> {
  const displayName = requireDisplayName(input.displayName);
  const workspace = newWorkspaceRow(ctx, displayName);
  const user = newUserRow(ctx, { ...input, displayName, workspaceId: workspace.id });
  const [, inserted] = await writeAll(ctx, (db) => [
    db.insert(workspaces).values(workspace),
    db.insert(users).values(user).returning(),
  ]);
  const row = inserted[0];
  if (!row) throw new Error(`Inserting user ${user.id} returned no row`);
  return row;
}

/**
 * Inserts a user who adopts an existing workspace without an owner, on the caller's
 * transaction (`tx` must be one). Shared with `./invites`.
 * @throws {RepositoryError} `not-found` for an unknown workspace; `conflict` when it has an owner.
 */
export async function insertUserAdoptingWorkspace(
  tx: RepositoryContext,
  input: NewUser & { workspaceId: string },
): Promise<UserRecord> {
  const displayName = requireDisplayName(input.displayName);
  const workspace = await tx.db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .get();
  if (!workspace) throw new RepositoryError('not-found', `Workspace ${input.workspaceId} does not exist`);
  const owner = await tx.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.workspaceId, input.workspaceId))
    .get();
  if (owner) throw new RepositoryError('conflict', `Workspace ${input.workspaceId} already has an owner`);
  return tx.db
    .insert(users)
    .values(newUserRow(tx, { ...input, displayName }))
    .returning()
    .get();
}

/** The row of a new user with a fresh id. */
function newUserRow(
  ctx: Pick<RepositoryContext, 'now' | 'newId'>,
  input: NewUser & { workspaceId: string },
): typeof users.$inferInsert {
  const now = ctx.now();
  return {
    id: ctx.newId(),
    workspaceId: input.workspaceId,
    displayName: input.displayName,
    role: input.role,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The display name trimmed.
 * @throws {RepositoryError} `invalid-input` for an empty one.
 */
export function requireDisplayName(displayName: string): string {
  const name = displayName.trim();
  if (name === '') throw new RepositoryError('invalid-input', 'A user needs a display name');
  return name;
}

/** A display name in the form in which names are compared: NFC, trimmed, lower case. */
export function foldName(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}
