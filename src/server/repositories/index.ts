/**
 * Persistence layer: the only code that touches SQL.
 *
 * `createRepositories(db)` binds one repository per aggregate to a database (or an
 * open transaction). Repositories speak domain types (`CanonicalSnapshot`,
 * `CardFacts`, ...) and the record types exported here; JSON columns are decoded and
 * validated on read, and every multi-statement write is atomic.
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
import { createDeckRepository, type DeckRepository } from './decks';
import { createCommitNoteRepository, type CommitNoteRepository } from './notes';
import { createObservationRepository, type ObservationRepository } from './observations';
import { createRawBlobRepository, type RawBlobRepository } from './raw-blobs';
import { createSettingsRepository, type SettingsRepository } from './settings';
import { createSnapshotRepository, type SnapshotRepository } from './snapshots';
import { createVersionTagRepository, type VersionTagRepository } from './tags';

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
  /** Workspace that decks are created in and listed from. Default: `local`. */
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
