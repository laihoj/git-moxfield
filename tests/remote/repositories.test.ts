/**
 * The repositories on a remote libSQL server: opening the app's database (never migrated
 * at runtime), constraint violations reported through error messages only (no extended
 * result codes remotely), atomic batches, single-use guarantees, and what card history and
 * card search cost in rows read (Turso bills every row a query reads).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LOCAL_WORKSPACE_ID, openDatabase } from '@/server/db/client';
import type { LibsqlDatabase } from '@/server/db/libsql';
import { applyMigrations, MigrationStateError } from '@/server/db/migration-state';
import * as schema from '@/server/db/schema';
import { createRepositories, type Repositories } from '@/server/repositories';
import { buildSnapshot } from '@tests/support/builders';
import {
  commitTestSnapshot,
  countRows,
  createTestDeck,
  expectDatabaseError,
  expectRepositoryError,
  sequentialIds,
  steppingClock,
} from '@tests/support/db';

import { openMetered, openRemote, remoteTarget, wipeRemoteDatabase, type Usage } from './support';

let handle: LibsqlDatabase;

beforeAll(async () => {
  await wipeRemoteDatabase();
  handle = await openRemote();
}, 120_000);

afterAll(() => {
  handle.close();
});

describe('opening the app database remotely', () => {
  it('refuses a database that is not migrated, without migrating it', async () => {
    const { url, authToken } = remoteTarget();
    await expect(openDatabase({ url, authToken })).rejects.toBeInstanceOf(MigrationStateError);
    expect(await handle.db.all(sql`SELECT name FROM sqlite_master WHERE type = 'table'`)).toEqual([]);
  });

  it('opens it once migrated, creating the local workspace', async () => {
    await applyMigrations(handle.db);
    const { url, authToken } = remoteTarget();
    const app = await openDatabase({ url, authToken });
    try {
      expect(app.kind).toBe('remote');
      expect(await app.db.select().from(schema.workspaces).all()).toEqual([
        { id: LOCAL_WORKSPACE_ID, name: 'Local', createdAt: expect.any(String) as string },
      ]);
    } finally {
      app.close();
    }
  });
});

describe('repositories on a remote database', () => {
  let repos: Repositories;

  beforeAll(async () => {
    await applyMigrations(handle.db);
    repos = createRepositories(handle.db, { now: steppingClock(), newId: sequentialIds('remote') });
  });

  it('report duplicates, dangling references and immutable history as on a local database', async () => {
    const deck = await createTestDeck(repos, { externalId: 'RemoteDeck0000000000001' });
    // The deck and its branch go in one batch; the remote UNIQUE violation reads as a conflict.
    await expectRepositoryError(createTestDeck(repos, { externalId: deck.externalId }), 'conflict');
    expect(await repos.branches.list(deck.id)).toHaveLength(1);

    // A duplicate that passes the check concurrently fails in the batch, atomically.
    const raced = await Promise.allSettled([
      createTestDeck(repos, { externalId: 'RemoteRace000000000001' }),
      createTestDeck(repos, { externalId: 'RemoteRace000000000001' }),
    ]);
    expect(raced.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(raced.find((result) => result.status === 'rejected')?.reason).toMatchObject({ code: 'conflict' });
    expect(await countRows(handle.db, 'branches')).toBe(2);

    const user = await repos.users.create({ displayName: 'Remote', role: 'member' });
    await repos.credentials.createKey({ userId: user.id, label: 'Laptop', secretHash: 'a'.repeat(64) });
    await expectRepositoryError(
      repos.credentials.createKey({ userId: user.id, label: 'Again', secretHash: 'a'.repeat(64) }),
      'conflict',
    );
    await expectRepositoryError(
      repos.credentials.createKey({ userId: 'nobody', label: 'Laptop', secretHash: 'b'.repeat(64) }),
      'not-found',
    );

    const v1 = await commitTestSnapshot(repos, deck, buildSnapshot({ zones: { mainboard: ['Sol Ring'] } }));
    await expectDatabaseError(
      handle.db.run(sql`UPDATE commits SET message = 'rewritten' WHERE id = ${v1.id}`),
      'trigger',
      /commits are immutable/,
    );
    expect(await repos.decks.delete(deck.id)).toBe(true);
    expect(await countRows(handle.db, 'commits')).toBe(0);
  });

  it('let exactly one of concurrent consumers use an invite', async () => {
    const token = 'c'.repeat(64);
    await repos.invites.create({
      tokenHash: token,
      role: 'member',
      note: '',
      createdByUserId: null,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const other = await openRemote();
    try {
      const results = await Promise.all([
        repos.invites.accept(token, '2026-06-01T00:00:00.000Z', { displayName: 'First' }),
        createRepositories(other.db).invites.accept(token, '2026-06-01T00:00:00.000Z', {
          displayName: 'Second',
        }),
      ]);
      expect(results.filter((result) => result !== null)).toHaveLength(1);
    } finally {
      other.close();
    }
  });
});

describe('rows read by card history and card search', () => {
  const VERSIONS = 30;
  const CARDS = 60;
  const usage: Usage = { rowsRead: 0, rowsWritten: 0 };
  let metered: Repositories;
  let deckId: string;

  /** Rows read by `operation`. */
  async function rowsRead(operation: () => Promise<unknown>): Promise<number> {
    const before = usage.rowsRead;
    await operation();
    return usage.rowsRead - before;
  }

  beforeAll(async () => {
    await applyMigrations(handle.db);
    metered = createRepositories(openMetered(usage), { now: steppingClock(), newId: sequentialIds('cost') });
    // Two decks whose cards drift by one per version: every card appears in many versions.
    for (const name of ['Measured', 'Neighbour']) {
      const deck = await createTestDeck(metered, { name });
      if (name === 'Measured') deckId = deck.id;
      for (let version = 0; version < VERSIONS; version++) {
        const cards = Array.from(
          { length: CARDS },
          (_, i) => `Card ${String((i + version) % 200).padStart(3, '0')}`,
        );
        await commitTestSnapshot(metered, deck, buildSnapshot({ zones: { mainboard: cards } }));
      }
    }
  }, 120_000);

  it('reads about one row per version for the history of one card', async () => {
    // "Card 059" is in versions 1–30 of both decks ((i + v) % 200 = 59 for i = 59 - v).
    let found = 0;
    const read = await rowsRead(async () => {
      found = (await metered.cardIndex.versionsContainingCard(deckId, 'Card 059')).length;
    });
    expect(found).toBe(VERSIONS);
    // Before the (card_key, snapshot_hash) index: every card row of every version (> 1,800).
    // Measured: 92 rows (sqld 0.24.32).
    expect(read, `rows read: ${read}`).toBeLessThanOrEqual(4 * VERSIONS);
  });

  it('reads each card row of the deck about once per search', async () => {
    let hits = 0;
    const read = await rowsRead(async () => {
      hits = (await metered.cardIndex.searchCardsInDeck(deckId, 'card 05', 10)).length;
    });
    expect(hits).toBe(10);
    // Before: about 7 rows per card row (window functions over the whole history).
    const deckCardRows = VERSIONS * CARDS;
    // Measured: 2,794 rows (sqld 0.24.32): 1,800 card rows, then the hits' versions.
    expect(read, `rows read: ${read}`).toBeLessThanOrEqual(2 * deckCardRows);
  });
});
