/**
 * Test helpers for the persistence layer.
 *
 * `openTestDatabase()` opens an isolated, fully migrated in-memory database (fast
 * enough to use one per test). `createTestRepositories()` additionally binds the
 * repositories with a deterministic clock and id generator. The seeding helpers mirror
 * what the service layer does (content-addressed commit ids, next sequence, parent =
 * HEAD, branch head moved atomically), so tests can build realistic histories quickly.
 */
import { expect } from 'vitest';

import { commitId } from '@/core/hash';
import type { CanonicalSnapshot, SourceDeckMetadata } from '@/core/model';
import type { IngestMethod } from '@/integrations/deck-source';
import { openDatabase, type Db } from '@/server/db/client';
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

/** Asserts that `fn` throws a {@link RepositoryError} with the given code; returns it. */
export function expectRepositoryError(fn: () => unknown, code: RepositoryErrorCode): RepositoryError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RepositoryError);
  expect(caught).toMatchObject({ code });
  return caught as RepositoryError;
}

/** Number of rows in a table (raw SQL, bypassing the repositories). */
export function countRows(db: Db, table: string): number {
  const row = db.$client.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
  return row.n;
}

/** Opens an isolated, migrated in-memory database with the local workspace seeded. */
export function openTestDatabase(): Db {
  return openDatabase(':memory:');
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
  db: Db;
  repos: Repositories;
}

/** In-memory database plus repositories with a stepping clock and sequential ids. */
export function createTestRepositories(options: RepositoryOptions = {}): TestDb {
  const db = openTestDatabase();
  const repos = createRepositories(db, { now: steppingClock(), newId: sequentialIds(), ...options });
  return { db, repos };
}

let deckCounter = 0;

/** Tracks a Moxfield-like deck with a unique external id unless one is given. */
export function createTestDeck(repos: Repositories, overrides: Partial<NewDeck> = {}): DeckRecord {
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
): CommitRecord {
  return repos.transaction((tx) => {
    const branch = tx.branches.getMain(deck.id);
    if (!branch) throw new Error(`Deck ${deck.id} has no main branch`);
    const sequence = options.sequence ?? (tx.commits.maxSequence(deck.id) ?? 0) + 1;
    const parentId = options.parentId === undefined ? branch.headCommitId : options.parentId;
    const snapshotHash = tx.snapshots.put(snapshot);
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
    const commit = tx.commits.insert({
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
      tx.branches.setHead(branch.id, commit.id, { expectedHeadCommitId: branch.headCommitId });
    }
    return commit;
  });
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
): ObservationRecord {
  return repos.transaction((tx) => {
    const snapshotHash = tx.snapshots.put(snapshot);
    const rawBlobHash = tx.rawBlobs.put({
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
