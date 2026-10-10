/**
 * Users: people with an account on this installation (ADR 0006). A user owns exactly one
 * workspace, created together with the user, and proves who they are with credentials
 * (`./credentials`), sessions and one-time links, which live in their own tables.
 *
 * Installation-wide (not scoped to the context's workspace). Display names are validated
 * by the auth service; this layer only rejects empty ones.
 */
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';

import { users, workspaces } from '@/server/db/schema';

import { withTransaction, type DbExecutor, type RepositoryContext } from './context';
import { RepositoryError } from './errors';
import { insertWorkspace } from './workspaces';

export type UserRole = (typeof users.$inferSelect)['role'];

export interface UserRecord {
  id: string;
  workspaceId: string;
  displayName: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
  /** Last request made with one of the user's sessions (recorded at most hourly). */
  lastSeenAt: string | null;
  /** When an admin disabled the user; disabled users cannot sign in. */
  disabledAt: string | null;
}

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

export interface UserRepository {
  /**
   * Creates a user together with a new workspace of its own, atomically.
   * @throws {RepositoryError} `invalid-input` for an empty display name.
   */
  create(input: NewUser): UserRecord;
  /**
   * Creates a user who adopts an existing workspace without an owner (the first admin
   * adopting `local`, so a single-user installation keeps its history). Atomic.
   * @throws {RepositoryError} `not-found` for an unknown workspace; `conflict` when the
   * workspace already has an owner; `invalid-input` for an empty display name.
   */
  createForWorkspace(input: NewUser & { workspaceId: string }): UserRecord;
  getById(id: string): UserRecord | null;
  /** The owner of a workspace, or `null` for an unowned (or unknown) workspace. */
  getByWorkspaceId(workspaceId: string): UserRecord | null;
  /** Users whose display name equals `name` ignoring case (names are not unique), oldest first. */
  findByDisplayName(name: string): UserRecord[];
  /** Number of users, disabled ones included. */
  count(): number;
  /** Number of admins who are not disabled. */
  countActiveAdmins(): number;
  /** Every user, oldest first (ties in creation order), with deck and active key counts. */
  list(): UserListItem[];
  /** @throws {RepositoryError} `not-found` for an unknown user; `invalid-input` for an empty name. */
  rename(id: string, displayName: string): UserRecord;
  /**
   * Disables a user (keeping the first `disabledAt`) or enables them again.
   * @throws {RepositoryError} `not-found` for an unknown user.
   */
  setDisabled(id: string, disabled: boolean): UserRecord;
  /** Records activity at `at`. Unknown users are ignored. */
  touchLastSeen(id: string, at: string): void;
}

export function createUserRepository(ctx: RepositoryContext): UserRepository {
  const requireUser = (db: DbExecutor, id: string): UserRecord => {
    const row = db.select().from(users).where(eq(users.id, id)).get();
    if (!row) throw new RepositoryError('not-found', `User ${id} does not exist`);
    return row;
  };

  return {
    create(input) {
      requireName(input.displayName);
      return withTransaction(ctx, (tx) => insertUserWithWorkspace(tx, input));
    },

    createForWorkspace(input) {
      requireName(input.displayName);
      return withTransaction(ctx, (tx) => insertUserAdoptingWorkspace(tx, input));
    },

    getById(id) {
      return ctx.db.select().from(users).where(eq(users.id, id)).get() ?? null;
    },

    getByWorkspaceId(workspaceId) {
      return ctx.db.select().from(users).where(eq(users.workspaceId, workspaceId)).get() ?? null;
    },

    findByDisplayName(name) {
      const wanted = foldName(name);
      if (wanted === '') return [];
      return ctx.db
        .select()
        .from(users)
        .orderBy(asc(users.createdAt), asc(sql`${users}.rowid`))
        .all()
        .filter((user) => foldName(user.displayName) === wanted);
    },

    count() {
      return ctx.db.select({ n: count() }).from(users).get()?.n ?? 0;
    },

    countActiveAdmins() {
      return (
        ctx.db
          .select({ n: count() })
          .from(users)
          .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)))
          .get()?.n ?? 0
      );
    },

    list() {
      return ctx.db
        .select({
          user: users,
          // Written out with aliases: Drizzle renders columns in a `sql` template without
          // their table, which inside a subquery would compare a table's column with itself.
          deckCount: sql<number>`(SELECT COUNT(*) FROM "decks" AS "d" WHERE "d"."workspace_id" = "users"."workspace_id")`,
          activeKeyCount: sql<number>`(SELECT COUNT(*) FROM "credentials" AS "c" WHERE "c"."user_id" = "users"."id" AND "c"."revoked_at" IS NULL)`,
        })
        .from(users)
        .orderBy(asc(users.createdAt), asc(sql`${users}.rowid`))
        .all()
        .map((row) => ({ ...row.user, deckCount: row.deckCount, activeKeyCount: row.activeKeyCount }));
    },

    rename(id, displayName) {
      const name = requireName(displayName);
      return withTransaction(ctx, ({ db }) => {
        requireUser(db, id);
        return db
          .update(users)
          .set({ displayName: name, updatedAt: ctx.now() })
          .where(eq(users.id, id))
          .returning()
          .get();
      });
    },

    setDisabled(id, disabled) {
      return withTransaction(ctx, ({ db }) => {
        const user = requireUser(db, id);
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

    touchLastSeen(id, at) {
      ctx.db.update(users).set({ lastSeenAt: at }).where(eq(users.id, id)).run();
    },
  };
}

/**
 * Inserts a user and a new workspace of its own on the caller's transaction (`tx` must
 * be one). Shared with `./invites`, which creates the user in the same transaction that
 * uses up the invite.
 */
export function insertUserWithWorkspace(tx: RepositoryContext, input: NewUser): UserRecord {
  const displayName = requireName(input.displayName);
  const workspace = insertWorkspace(tx.db, tx, displayName);
  return insertUser(tx, { ...input, displayName, workspaceId: workspace.id });
}

/**
 * Inserts a user who adopts an existing workspace without an owner, on the caller's
 * transaction (`tx` must be one). Shared with `./invites`.
 * @throws {RepositoryError} `not-found` for an unknown workspace; `conflict` when it has an owner.
 */
export function insertUserAdoptingWorkspace(
  tx: RepositoryContext,
  input: NewUser & { workspaceId: string },
): UserRecord {
  const displayName = requireName(input.displayName);
  const workspace = tx.db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .get();
  if (!workspace) throw new RepositoryError('not-found', `Workspace ${input.workspaceId} does not exist`);
  const owner = tx.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.workspaceId, input.workspaceId))
    .get();
  if (owner) throw new RepositoryError('conflict', `Workspace ${input.workspaceId} already has an owner`);
  return insertUser(tx, { ...input, displayName });
}

function insertUser(tx: RepositoryContext, input: NewUser & { workspaceId: string }): UserRecord {
  const now = tx.now();
  return tx.db
    .insert(users)
    .values({
      id: tx.newId(),
      workspaceId: input.workspaceId,
      displayName: input.displayName,
      role: input.role,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

function requireName(displayName: string): string {
  const name = displayName.trim();
  if (name === '') throw new RepositoryError('invalid-input', 'A user needs a display name');
  return name;
}

function foldName(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}
