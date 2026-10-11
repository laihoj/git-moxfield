/**
 * Test helpers for the persistence layer.
 *
 * `openTestDatabase()` opens an isolated, fully migrated in-memory libSQL database (fast
 * enough to use one per test) and closes it when the test finishes.
 * `createTestRepositories()` additionally binds the repositories with a deterministic clock
 * and id generator. The seeding helpers mirror what the service layer does
 * (content-addressed commit ids, next sequence, parent = HEAD, branch head moved
 * atomically), so tests can build realistic histories quickly. Everything is asynchronous,
 * like the database.
 */
import { expect } from 'vitest';

import { commitId } from '@/core/hash';
import type { CanonicalSnapshot, SourceDeckMetadata } from '@/core/model';
import type { IngestMethod } from '@/integrations/deck-source';
import { openDatabase, type OpenDatabaseOptions } from '@/server/db/client';
import type { LibsqlDatabase, LibsqlDb } from '@/server/db/libsql';
import { classifySqlError, type SqlErrorClassification, type SqlErrorKind } from '@/server/db/sql-errors';
import {
  createRepositories,
  RepositoryError,
  type CommitRecord,
  type DeckRecord,
  type NewDeck,
  type ObservationRecord,
  type Repositories,
  type RepositoryErrorCode,
  type RepositoryOptions,
} from '@/server/repositories';

import { cleanUpAfterTest } from './libsql';

export { countRows } from './libsql';

/**
 * Asserts that `operation` (a promise, or a function returning one or throwing) fails with
 * a {@link RepositoryError} with the given code; returns the error.
 */
export async function expectRepositoryError(
  operation: Promise<unknown> | (() => unknown),
  code: RepositoryErrorCode,
): Promise<RepositoryError> {
  let caught: unknown;
  try {
    await (typeof operation === 'function' ? operation() : operation);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RepositoryError);
  expect(caught).toMatchObject({ code });
  return caught as RepositoryError;
}

/**
 * Asserts that `operation` fails with a database error of `kind` (see `classifySqlError`;
 * Drizzle wraps driver errors, so their text is not in the message) whose driver message
 * matches `message`; returns the classification.
 */
export async function expectDatabaseError(
  operation: Promise<unknown>,
  kind: SqlErrorKind,
  message?: RegExp,
): Promise<SqlErrorClassification> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const failure = classifySqlError(caught);
  expect(failure.kind).toBe(kind);
  if (message !== undefined) expect(failure.message).toMatch(message);
  return failure;
}

/**
 * Opens a migrated database with the local workspace (default: an isolated in-memory one)
 * and closes it when the current test finishes. For tests that need the handle itself
 * (its client, its write lock, closing and reopening a file).
 */
export async function openTestDatabaseHandle(
  options: Partial<OpenDatabaseOptions> = {},
): Promise<LibsqlDatabase> {
  const handle = await openDatabase({ url: ':memory:', ...options });
  cleanUpAfterTest(() => {
    handle.close();
  });
  return handle;
}

/** Opens an isolated, migrated in-memory database with the local workspace seeded. */
export async function openTestDatabase(options: Partial<OpenDatabaseOptions> = {}): Promise<LibsqlDb> {
  return (await openTestDatabaseHandle(options)).db;
}

/** A clock that advances by `stepMs` on every call, starting at `start`. */
export function steppingClock(start = '2026-01-01T00:00:00.000Z', stepMs = 1_000): () => Date {
  let next = Date.parse(start);
  return () => {
    const now = new Date(next);
    next += stepMs;
    return now;
  };
}

/** Sequential ids: `id-0001`, `id-0002`, ... */
export function sequentialIds(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(4, '0')}`;
}

export interface TestDb {
  db: LibsqlDb;
  repos: Repositories;
}

/** In-memory database plus repositories with a stepping clock and sequential ids. */
export async function createTestRepositories(options: RepositoryOptions = {}): Promise<TestDb> {
  const db = await openTestDatabase();
  const repos = createRepositories(db, { now: steppingClock(), newId: sequentialIds(), ...options });
  return { db, repos };
}

let deckCounter = 0;

/** Tracks a Moxfield-like deck with a unique external id unless one is given. */
export function createTestDeck(repos: Repositories, overrides: Partial<NewDeck> = {}): Promise<DeckRecord> {
  const externalId = overrides.externalId ?? `TestDeck${String(++deckCounter).padStart(14, '0')}`;
  return repos.decks.create({
    source: 'moxfield',
    externalId,
    url: `https://moxfield.com/decks/${externalId}`,
    name: 'Test Deck',
    format: 'commander',
    ...overrides,
  });
}

/** Source metadata consistent with a tracked deck. */
export function testSourceMetadata(
  deck: Pick<DeckRecord, 'source' | 'externalId' | 'url' | 'name' | 'format'>,
  overrides: Partial<SourceDeckMetadata> = {},
): SourceDeckMetadata {
  return {
    source: deck.source,
    externalId: deck.externalId,
    url: deck.url,
    name: deck.name,
    format: deck.format,
    authors: ['tester'],
    reportedCounts: {},
    ...overrides,
  };
}

export interface TestCommitOptions {
  message?: string;
  /** Default: one hour per sequence after 2026-01-01. */
  createdAt?: string;
  /** Default: the current HEAD. */
  parentId?: string | null;
  /** Default: highest sequence + 1. */
  sequence?: number;
  /** Default: the sequence. */
  sourceVersion?: number | null;
  rawBlobHash?: string | null;
  ingestMethod?: IngestMethod;
  /** Move the main branch head to the new commit (default true). */
  moveHead?: boolean;
}

/** Stores `snapshot` and commits it on the deck's main branch, like the commit service. */
export function commitTestSnapshot(
  repos: Repositories,
  deck: DeckRecord,
  snapshot: CanonicalSnapshot,
  options: TestCommitOptions = {},
): Promise<CommitRecord> {
  return repos.transaction(async (tx) => {
    const branch = await tx.branches.getMain(deck.id);
    if (!branch) throw new Error(`Deck ${deck.id} has no main branch`);
    const sequence = options.sequence ?? ((await tx.commits.maxSequence(deck.id)) ?? 0) + 1;
    const parentId = options.parentId === undefined ? branch.headCommitId : options.parentId;
    const snapshotHash = await tx.snapshots.put(snapshot);
    const createdAt =
      options.createdAt ?? new Date(Date.UTC(2026, 0, 1) + sequence * 3_600_000).toISOString();
    const message = options.message ?? `Version ${sequence}`;
    const sourceVersion = options.sourceVersion === undefined ? sequence : options.sourceVersion;
    const id = commitId({
      deck: `${deck.source}:${deck.externalId}`,
      snapshotHash,
      parentId,
      createdAt,
      sourceVersion,
      message,
    });
    const commit = await tx.commits.insert({
      id,
      deckId: deck.id,
      branchId: branch.id,
      sequence,
      parentId,
      snapshotHash,
      rawBlobHash: options.rawBlobHash ?? null,
      message,
      createdAt,
      ingestMethod: options.ingestMethod ?? 'server',
      fetchedAt: createdAt,
      sourceVersion,
      sourceUpdatedAt: null,
      sourceMetadata: testSourceMetadata(deck, sourceVersion === null ? {} : { version: sourceVersion }),
    });
    if (options.moveHead ?? true) {
      await tx.branches.setHead(branch.id, commit.id, { expectedHeadCommitId: branch.headCommitId });
    }
    return commit;
  });
}

/** Commits the snapshots one after another, each on top of the previous (successive versions). */
export async function commitTestSnapshots(
  repos: Repositories,
  deck: DeckRecord,
  snapshots: readonly CanonicalSnapshot[],
): Promise<CommitRecord[]> {
  const commits: CommitRecord[] = [];
  for (const snapshot of snapshots) commits.push(await commitTestSnapshot(repos, deck, snapshot));
  return commits;
}

export interface TestObservationOptions {
  fetchedAt?: string;
  ingestMethod?: IngestMethod;
  /** Raw payload stored alongside (default: a small wrapper around the snapshot). */
  raw?: unknown;
}

/** Stores `snapshot` and a raw payload and records them as an observation of the deck. */
export function observeTestSnapshot(
  repos: Repositories,
  deck: DeckRecord,
  snapshot: CanonicalSnapshot,
  options: TestObservationOptions = {},
): Promise<ObservationRecord> {
  return repos.transaction(async (tx) => {
    const snapshotHash = await tx.snapshots.put(snapshot);
    const rawBlobHash = await tx.rawBlobs.put({
      mediaType: 'application/vnd.git-moxfield.test+json',
      data: options.raw ?? { deck: deck.externalId, snapshot },
    });
    return tx.observations.insert({
      deckId: deck.id,
      snapshotHash,
      rawBlobHash,
      ingestMethod: options.ingestMethod ?? 'server',
      fetchedAt: options.fetchedAt ?? '2026-02-01T00:00:00.000Z',
      sourceVersion: null,
      sourceUpdatedAt: null,
      sourceMetadata: testSourceMetadata(deck),
      warnings: [],
    });
  });
}
