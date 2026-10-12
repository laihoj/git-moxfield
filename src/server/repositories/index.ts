/**
 * Persistence layer: the only code that touches SQL.
 *
 * `createRepositories(db, { workspaceId })` binds one repository per aggregate to a
 * database (or an open transaction). Repositories speak domain types
 * (`CanonicalSnapshot`, `CardFacts`, ...) and the record types exported here; JSON
 * columns are decoded and validated on read, and every multi-statement write is atomic.
 * Every method is asynchronous (libSQL, ADR 0008); remotely each query is a round trip,
 * so independent reads are worth starting together (`Promise.all`).
 *
 * Two kinds of repositories share the binding:
 * - **Deck data** (decks, branches, commits, observations, tags, notes, card index, card
 *   catalog) is scoped to the bound workspace: a deck, commit or observation id of
 *   another workspace behaves like an unknown id, and card facts one workspace captures
 *   never reach another. Snapshots and raw payloads are content-addressed (keyed by the
 *   hash of what they hold) and shared by all workspaces.
 * - **Accounts** (workspaces, users, credentials, sessions, login links, invites),
 *   settings and the Moxfield rate limiter are installation-wide; the bound workspace does
 *   not affect them.
 * - **Share links** are both: the owner creates, lists and revokes them for decks of the
 *   bound workspace only, while resolving a link's token is installation-wide (the token
 *   is its own authorization; see `./share-links`).
 * - **History transfer** (operator tools: `pnpm import:local`) reads a deck's stored
 *   history row for row from the bound workspace, and writes such rows into it, verified
 *   and unchanged (see `./history-transfer`).
 *
 * Use {@link Repositories.transaction} to make several repository calls atomic, e.g.
 * "verify HEAD, insert commit, move the branch head" when committing.
 */
import { randomUUID } from 'node:crypto';

import type { TransactionOptions } from '@/server/db/transaction';

import { LOCAL_WORKSPACE_ID } from '@/server/db/client';

import { createBranchRepository, type BranchRepository } from './branches';
import { createCardIndexRepository, type CardIndexRepository } from './card-index';
import { createCatalogRepository, type CatalogRepository } from './catalog';
import { createCommitRepository, type CommitRepository } from './commits';
import { withTransaction, type LibsqlExecutor, type RepositoryContext } from './context';
import { createCredentialRepository, type CredentialRepository } from './credentials';
import { createDeckRepository, type DeckRepository } from './decks';
import { createHistoryTransferRepository, type HistoryTransferRepository } from './history-transfer';
import { createInviteRepository, type InviteRepository } from './invites';
import { createLoginLinkRepository, type LoginLinkRepository } from './login-links';
import { createMoxfieldRateRepository, type MoxfieldRateRepository } from './moxfield-rate';
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
  /** The installation-wide limiter of server-side requests to Moxfield (ADR 0009). */
  readonly moxfieldRate: MoxfieldRateRepository;
  readonly workspaces: WorkspaceRepository;
  readonly users: UserRepository;
  readonly credentials: CredentialRepository;
  readonly sessions: SessionRepository;
  readonly loginLinks: LoginLinkRepository;
  readonly invites: InviteRepository;
  readonly shareLinks: ShareLinkRepository;
  /** Copying stored history between databases (operator tools: `pnpm import:local`). */
  readonly historyTransfer: HistoryTransferRepository;
  /**
   * Runs `fn` atomically with repositories bound to one `BEGIN IMMEDIATE` transaction: if
   * `fn` throws, every write it made is rolled back. Nested calls use savepoints. The rules
   * of `runInTransaction` (`src/server/db/transaction.ts`) apply: inside `fn` use only the
   * repositories it receives, keep it short and free of network I/O (no Moxfield fetches),
   * never wait for a deck lock in it, and let it run more than once (it is retried after a
   * transient failure), so it must not have effects outside the database.
   */
  transaction<T>(fn: (repos: Repositories) => Promise<T>, options?: TransactionOptions): Promise<T>;
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
export function createRepositories(db: LibsqlExecutor, options: RepositoryOptions = {}): Repositories {
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
    moxfieldRate: createMoxfieldRateRepository(ctx),
    workspaces: createWorkspaceRepository(ctx),
    users: createUserRepository(ctx),
    credentials: createCredentialRepository(ctx),
    sessions: createSessionRepository(ctx),
    loginLinks: createLoginLinkRepository(ctx),
    invites: createInviteRepository(ctx),
    shareLinks: createShareLinkRepository(ctx),
    historyTransfer: createHistoryTransferRepository(ctx),
    transaction: (fn, options) => withTransaction(ctx, (tx) => fn(bind(tx)), options),
  };
}

export { MAX_STORED_VALUE_BYTES, type LibsqlExecutor } from './context';
export { RepositoryError, isRepositoryError, type RepositoryErrorCode } from './errors';
export {
  MAIN_BRANCH_NAME,
  type DeckCachedInfo,
  type DeckRecord,
  type DeckRelinkInput,
  type DeckRelinkRecord,
  type DeckRepository,
  type FetchErrorRecord,
  type NewDeck,
} from './decks';
export type { BranchKind, BranchRecord, BranchRepository, SetHeadOptions } from './branches';
export type { SnapshotRepository } from './snapshots';
export type { RawBlob, RawBlobInfo, RawBlobInput, RawBlobRepository } from './raw-blobs';
export type {
  NewObservation,
  ObservationRecord,
  ObservationRepository,
  ObservationWithSnapshot,
} from './observations';
export {
  isCommitIdPrefix,
  type CommitRecord,
  type CommitRepository,
  type CommitWithSnapshot,
} from './commits';
export {
  DEFAULT_CARD_SEARCH_LIMIT,
  foldForSearch,
  type CardIndexRepository,
  type CardSearchHit,
  type CardVersionZones,
} from './card-index';
export type { TagCount, VersionTagRepository } from './tags';
export type { CommitNoteRecord, CommitNoteRepository } from './notes';
export type { CatalogRepository } from './catalog';
export type { SettingsRepository } from './settings';
export type {
  MoxfieldRateRepository,
  MoxfieldRateState,
  MoxfieldReservation,
  RecordRateLimitOptions,
  ReserveOptions,
} from './moxfield-rate';
export type { DeckLocation, WorkspaceRecord, WorkspaceRepository } from './workspaces';
export { foldName, isActiveAdminRecord } from './users';
export type { NewUser, UserListItem, UserRecord, UserRepository } from './users';
export type { UserRole } from '@/core/roles';
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
export {
  assertCommitsContentAddressed,
  deckReferences,
  historyRowIds,
  TRANSFER_ID_KINDS,
  type BranchRow,
  type CardCatalogRow,
  type CommitLocation,
  type CommitNoteRow,
  type CommitRow,
  type DeckHistoryRows,
  type DeckRelinkRow,
  type DeckRow,
  type HistoryTransferRepository,
  type ObservationRow,
  type RawBlobRow,
  type SnapshotRow,
  type TransferIdKind,
  type VersionTagRow,
} from './history-transfer';
