/**
 * Persistence layer: the only code that touches SQL.
 *
 * `createRepositories(db, { workspaceId })` binds one repository per aggregate to a
 * database (or an open transaction). Repositories speak domain types
 * (`CanonicalSnapshot`, `CardFacts`, ...) and the record types exported here; JSON
 * columns are decoded and validated on read, and every multi-statement write is atomic.
 *
 * Two kinds of repositories share the binding:
 * - **Deck data** (decks, branches, commits, observations, tags, notes, card index, card
 *   catalog) is scoped to the bound workspace: a deck, commit or observation id of
 *   another workspace behaves like an unknown id, and card facts one workspace captures
 *   never reach another. Snapshots and raw payloads are content-addressed (keyed by the
 *   hash of what they hold) and shared by all workspaces.
 * - **Accounts** (workspaces, users, credentials, sessions, login links, invites) and
 *   settings are installation-wide; the bound workspace does not affect them.
 * - **Share links** are both: the owner creates, lists and revokes them for decks of the
 *   bound workspace only, while resolving a link's token is installation-wide (the token
 *   is its own authorization; see `./share-links`).
 *
 * Use {@link Repositories.transaction} to make several repository calls atomic, e.g.
 * "verify HEAD, insert commit, move the branch head" when committing.
 */
import { randomUUID } from 'node:crypto';

import { LOCAL_WORKSPACE_ID } from '@/server/db/client';

import { createBranchRepository, type BranchRepository } from './branches';
import { createCardIndexRepository, type CardIndexRepository } from './card-index';
import { createCatalogRepository, type CatalogRepository } from './catalog';
import { createCommitRepository, type CommitRepository } from './commits';
import { withTransaction, type DbExecutor, type RepositoryContext } from './context';
import { createCredentialRepository, type CredentialRepository } from './credentials';
import { createDeckRepository, type DeckRepository } from './decks';
import { createInviteRepository, type InviteRepository } from './invites';
import { createLoginLinkRepository, type LoginLinkRepository } from './login-links';
import { createCommitNoteRepository, type CommitNoteRepository } from './notes';
import { createObservationRepository, type ObservationRepository } from './observations';
import { createRawBlobRepository, type RawBlobRepository } from './raw-blobs';
import { createSessionRepository, type SessionRepository } from './sessions';
import { createSettingsRepository, type SettingsRepository } from './settings';
import { createShareLinkRepository, type ShareLinkRepository } from './share-links';
import { createSnapshotRepository, type SnapshotRepository } from './snapshots';
import { createVersionTagRepository, type VersionTagRepository } from './tags';
import { createUserRepository, type UserRepository } from './users';
import { createWorkspaceRepository, type WorkspaceRepository } from './workspaces';

export interface Repositories {
  readonly decks: DeckRepository;
  readonly branches: BranchRepository;
  readonly snapshots: SnapshotRepository;
  readonly rawBlobs: RawBlobRepository;
  readonly observations: ObservationRepository;
  readonly commits: CommitRepository;
  readonly cardIndex: CardIndexRepository;
  readonly tags: VersionTagRepository;
  readonly notes: CommitNoteRepository;
  readonly catalog: CatalogRepository;
  readonly settings: SettingsRepository;
  readonly workspaces: WorkspaceRepository;
  readonly users: UserRepository;
  readonly credentials: CredentialRepository;
  readonly sessions: SessionRepository;
  readonly loginLinks: LoginLinkRepository;
  readonly invites: InviteRepository;
  readonly shareLinks: ShareLinkRepository;
  /**
   * Runs `fn` atomically with repositories bound to one transaction: if `fn` throws,
   * every write it made is rolled back. Nested calls use savepoints. `fn` must be
   * synchronous (better-sqlite3 transactions cannot span an `await`).
   */
  transaction<T>(fn: (repos: Repositories) => T): T;
}

export interface RepositoryOptions {
  /** Clock for `createdAt`/`updatedAt` columns the repositories fill in. Default: system time. */
  now?: () => Date;
  /** Id generator for decks, branches, observations and notes. Default: `crypto.randomUUID`. */
  newId?: () => string;
  /**
   * Workspace that deck data is scoped to: decks are created in it, and decks, versions,
   * observations, tags, notes and card facts of other workspaces are invisible. Default: `local`, the
   * workspace of pre-account installations (tests and operator scripts); request-handling
   * code always passes the signed-in user's workspace (see `src/server/access`).
   */
  workspaceId?: string;
}

/** Binds all repositories to a database or an open transaction. */
export function createRepositories(db: DbExecutor, options: RepositoryOptions = {}): Repositories {
  const clock = options.now ?? (() => new Date());
  return bind({
    db,
    workspaceId: options.workspaceId ?? LOCAL_WORKSPACE_ID,
    now: () => clock().toISOString(),
    newId: options.newId ?? randomUUID,
  });
}

function bind(ctx: RepositoryContext): Repositories {
  return {
    decks: createDeckRepository(ctx),
    branches: createBranchRepository(ctx),
    snapshots: createSnapshotRepository(ctx),
    rawBlobs: createRawBlobRepository(ctx),
    observations: createObservationRepository(ctx),
    commits: createCommitRepository(ctx),
    cardIndex: createCardIndexRepository(ctx),
    tags: createVersionTagRepository(ctx),
    notes: createCommitNoteRepository(ctx),
    catalog: createCatalogRepository(ctx),
    settings: createSettingsRepository(ctx),
    workspaces: createWorkspaceRepository(ctx),
    users: createUserRepository(ctx),
    credentials: createCredentialRepository(ctx),
    sessions: createSessionRepository(ctx),
    loginLinks: createLoginLinkRepository(ctx),
    invites: createInviteRepository(ctx),
    shareLinks: createShareLinkRepository(ctx),
    transaction: (fn) => withTransaction(ctx, (tx) => fn(bind(tx))),
  };
}

export type { DbExecutor } from './context';
export { RepositoryError, isRepositoryError, type RepositoryErrorCode } from './errors';
export {
  MAIN_BRANCH_NAME,
  type DeckCachedInfo,
  type DeckRecord,
  type DeckRepository,
  type FetchErrorRecord,
  type NewDeck,
} from './decks';
export type { BranchKind, BranchRecord, BranchRepository, SetHeadOptions } from './branches';
export type { SnapshotRepository } from './snapshots';
export type { RawBlob, RawBlobInfo, RawBlobInput, RawBlobRepository } from './raw-blobs';
export type { NewObservation, ObservationRecord, ObservationRepository } from './observations';
export { MIN_COMMIT_ID_PREFIX_LENGTH, type CommitRecord, type CommitRepository } from './commits';
export {
  DEFAULT_CARD_SEARCH_LIMIT,
  foldForSearch,
  type CardIndexRepository,
  type CardSearchHit,
  type CardVersionZones,
} from './card-index';
export {
  MAX_VERSION_TAG_LENGTH,
  normalizeVersionTag,
  type TagCount,
  type VersionTagRepository,
  type VersionTagValidation,
} from './tags';
export type { CommitNoteRecord, CommitNoteRepository } from './notes';
export type { CatalogRepository } from './catalog';
export type { SettingsRepository } from './settings';
export type { DeckLocation, WorkspaceRecord, WorkspaceRepository } from './workspaces';
export type { NewUser, UserListItem, UserRecord, UserRepository, UserRole } from './users';
export type {
  CredentialKind,
  CredentialRecord,
  CredentialRepository,
  NewBookmarkletKey,
} from './credentials';
export type { NewSession, PendingHandoff, SessionOrigin, SessionRecord, SessionRepository } from './sessions';
export type {
  LoginLinkPurpose,
  LoginLinkRecord,
  LoginLinkRepository,
  NewLoginLink,
  UnusedLinkFilter,
} from './login-links';
export type { InviteRecord, InviteRepository, NewInvite } from './invites';
export type { ActiveShareLink, NewShareLink, ShareLinkRecord, ShareLinkRepository } from './share-links';
