/**
 * The history transfer repository (`pnpm import:local`): it moves stored history between
 * databases without changing a byte, verifies everything it copies, writes a deck's
 * history atomically and refuses what would duplicate or corrupt history in the target.
 */
import { eq, getTableColumns, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { commitId } from '@/core/hash';
import { cardCatalog } from '@/server/db/schema';
import { createRepositories, type DeckHistoryRows, type Repositories } from '@/server/repositories';
import { batchBySize, TRANSFER_BATCH_BYTES, TRANSFER_BATCH_ROWS } from '@/server/history-import';
import { baseDeckSpec, buildSnapshot } from '@tests/support/builders';
import {
  commitTestSnapshot,
  countRows,
  createTestDeck,
  createTestRepositories,
  expectRepositoryError,
  observeTestSnapshot,
} from '@tests/support/db';

const V1 = buildSnapshot(baseDeckSpec());
const V2 = buildSnapshot({ ...baseDeckSpec(), primer: '# Updated\n' });

/** A source database with one deck: two versions (a tag, a note), an observation. */
async function sourceDeck() {
  const { db, repos } = await createTestRepositories();
  const deck = await createTestDeck(repos, { externalId: 'TransferDeck0000000001' });
  const v1 = await commitTestSnapshot(repos, deck, V1);
  const v2 = await commitTestSnapshot(repos, deck, V2);
  await observeTestSnapshot(repos, deck, V2, { raw: { some: 'payload' } });
  await repos.tags.add(v1.id, 'stable');
  await repos.notes.upsert(v2.id, 'note', { text: 'Top 4' });
  await repos.catalog.upsertMany([
    {
      key: 'sol ring',
      name: 'Sol Ring',
      typeLine: 'Artifact',
      primaryType: 'Artifact',
      manaCost: '{1}',
      cmc: 1,
      colorIdentity: [],
      layout: 'normal',
    },
  ]);
  const rows = await repos.historyTransfer.readDeckHistory(deck.id);
  if (!rows) throw new Error('no rows');
  return { db, repos, deck, v1, v2, rows };
}

/** Copies the content `rows` references from `from` to `to`. */
async function copyContent(from: Repositories, to: Repositories, rows: DeckHistoryRows): Promise<void> {
  const snapshots = [...new Set([...rows.commits, ...rows.observations].map((row) => row.snapshotHash))];
  const blobs = [...rows.commits, ...rows.observations].flatMap((row) =>
    row.rawBlobHash === null ? [] : [row.rawBlobHash],
  );
  await to.historyTransfer.insertSnapshots(await from.historyTransfer.readSnapshots(snapshots));
  await to.historyTransfer.insertRawBlobs(await from.historyTransfer.readRawBlobs(blobs));
}

describe('history transfer repository', () => {
  it('reads a deck’s history row for row and writes it into another database unchanged', async () => {
    const source = await sourceDeck();
    expect(source.rows).toMatchObject({
      deck: { id: source.deck.id, externalId: 'TransferDeck0000000001' },
      commits: [{ id: source.v1.id }, { id: source.v2.id }],
      versionTags: [{ commitId: source.v1.id, name: 'stable' }],
      commitNotes: [{ commitId: source.v2.id, kind: 'note' }],
      relinks: [],
    });
    expect(source.rows.observations).toHaveLength(1);

    const { db, repos } = await createTestRepositories();
    await copyContent(source.repos, repos, source.rows);
    await repos.historyTransfer.insertDeckHistory(source.rows);

    expect(await repos.historyTransfer.readDeckHistory(source.deck.id)).toEqual(source.rows);
    expect(await repos.snapshots.get(source.v2.snapshotHash)).toEqual(V2);
    expect(await repos.cardIndex.versionsContainingCard(source.deck.id, 'Sol Ring')).toHaveLength(2);
    expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
    expect((await repos.commits.head(source.deck.id))?.id).toBe(source.v2.id);

    // Content that exists is skipped.
    await copyContent(source.repos, repos, source.rows);
    expect(await countRows(db, 'snapshots')).toBe(2);
  });

  it('writes a deck into the bound workspace and refuses it twice, atomically', async () => {
    const source = await sourceDeck();
    const { db, repos } = await createTestRepositories();
    const user = await repos.users.create({ displayName: 'Mikko', role: 'member' });
    const theirs = createRepositories(db, { workspaceId: user.workspaceId });
    await copyContent(source.repos, theirs, source.rows);
    await theirs.historyTransfer.insertDeckHistory(source.rows);
    expect((await theirs.decks.getById(source.deck.id))?.workspaceId).toBe(user.workspaceId);
    expect(await repos.decks.getById(source.deck.id)).toBeNull();

    const decks = await countRows(db, 'decks');
    // The same rows again: the workspace tracks the deck already.
    await expectRepositoryError(theirs.historyTransfer.insertDeckHistory(source.rows), 'conflict');
    // Another workspace, with fresh deck and row ids: the versions are stored already.
    const fresh = {
      ...source.rows,
      deck: { ...source.rows.deck, id: 'another-deck' },
      branches: source.rows.branches.map((branch) => ({
        ...branch,
        id: `${branch.id}-2`,
        deckId: 'another-deck',
      })),
      commits: source.rows.commits.map((commit) => ({
        ...commit,
        deckId: 'another-deck',
        branchId: `${commit.branchId}-2`,
      })),
      observations: [],
      commitNotes: [],
    };
    await expectRepositoryError(repos.historyTransfer.insertDeckHistory(fresh), 'conflict');
    expect(await countRows(db, 'decks')).toBe(decks);
    expect(await countRows(db, 'branches')).toBe(decks);
  });

  it('refuses a history whose snapshots or raw payloads are not stored', async () => {
    const source = await sourceDeck();
    const { db, repos } = await createTestRepositories();
    const error = await expectRepositoryError(
      repos.historyTransfer.insertDeckHistory(source.rows),
      'not-found',
    );
    expect(error.message).toContain('references a snapshot or raw payload that is not stored');
    expect(await countRows(db, 'decks')).toBe(0);
  });

  it('refuses versions that do not match their content, before writing anything', async () => {
    const source = await sourceDeck();
    const { db, repos } = await createTestRepositories();
    await copyContent(source.repos, repos, source.rows);
    const [v1, v2] = source.rows.commits;
    if (!v1 || !v2) throw new Error('two versions expected');
    const tampered = { ...source.rows, commits: [v1, { ...v2, message: 'Rewritten history' }] };
    const error = await expectRepositoryError(
      repos.historyTransfer.insertDeckHistory(tampered),
      'invalid-input',
    );
    expect(error.message).toContain('does not match its content');
    const orphan = { ...source.rows, commits: [v2] };
    await expectRepositoryError(repos.historyTransfer.insertDeckHistory(orphan), 'invalid-input');
    expect(await countRows(db, 'decks')).toBe(0);
  });

  it('accepts versions committed under the deck’s earlier Moxfield deck', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos, { externalId: 'OldDeckId' });
    const v1 = await commitTestSnapshot(repos, deck, V1);
    await repos.decks.relink(deck.id, {
      expectedExternalId: 'OldDeckId',
      externalId: 'NewDeckId',
      url: 'https://moxfield.com/decks/NewDeckId',
    });
    const rows = await repos.historyTransfer.readDeckHistory(deck.id);
    if (!rows) throw new Error('no rows');
    expect(v1.id).toBe(
      commitId({
        deck: 'moxfield:OldDeckId',
        snapshotHash: v1.snapshotHash,
        parentId: null,
        createdAt: v1.createdAt,
        sourceVersion: v1.sourceVersion,
        message: v1.message,
      }),
    );
    const target = await createTestRepositories();
    await copyContent(repos, target.repos, rows);
    await target.repos.historyTransfer.insertDeckHistory(rows);
    expect(await target.repos.decks.listRelinks(deck.id)).toHaveLength(1);
    // Without the record of the change, v1 would not verify.
    const other = await createTestRepositories();
    await copyContent(repos, other.repos, rows);
    await expectRepositoryError(
      other.repos.historyTransfer.insertDeckHistory({ ...rows, relinks: [] }),
      'invalid-input',
    );
  });

  it('verifies content against its hash when reading and when writing', async () => {
    const source = await sourceDeck();
    const [snapshot] = await source.repos.historyTransfer.readSnapshots([source.v1.snapshotHash]);
    if (!snapshot) throw new Error('no snapshot');
    const target = await createTestRepositories();
    await expectRepositoryError(
      target.repos.historyTransfer.insertSnapshots([
        { ...snapshot, canonicalJson: snapshot.canonicalJson.replace('1', '2') },
      ]),
      'corrupt-data',
    );
    const [blobHash] = source.rows.observations.map((row) => row.rawBlobHash);
    const [blob] = await source.repos.historyTransfer.readRawBlobs([blobHash ?? '']);
    if (!blob) throw new Error('no blob');
    await expectRepositoryError(
      target.repos.historyTransfer.insertRawBlobs([{ ...blob, byteLength: blob.byteLength + 1 }]),
      'corrupt-data',
    );
    expect(await countRows(target.db, 'snapshots')).toBe(0);
    expect(await countRows(target.db, 'raw_blobs')).toBe(0);
  });

  it('lists what the target lacks, which ids it uses and where commits are', async () => {
    const source = await sourceDeck();
    const target = await createTestRepositories();
    const hashes = [source.v1.snapshotHash, source.v2.snapshotHash];
    expect(await target.repos.historyTransfer.missingSnapshots([...hashes, ...hashes])).toEqual(hashes);
    expect(await source.repos.historyTransfer.missingSnapshots(hashes)).toEqual([]);
    expect(await source.repos.historyTransfer.takenIds('deck', [source.deck.id, 'unknown'])).toEqual(
      new Set([source.deck.id]),
    );
    expect(await source.repos.historyTransfer.locateCommits([source.v1.id, 'unknown'])).toEqual([
      { commitId: source.v1.id, deckId: source.deck.id, workspaceId: 'local' },
    ]);
    expect(await source.repos.historyTransfer.cardKeysOf(hashes)).toContain('sol ring');
    const sizes = await source.repos.historyTransfer.snapshotSizes(hashes);
    expect([...sizes.values()].every((bytes) => bytes > 100)).toBe(true);
  });

  it('merges card facts so that the facts written last win', async () => {
    const source = await sourceDeck();
    const [facts] = await source.repos.historyTransfer.readCatalog(['sol ring', 'unknown']);
    if (!facts) throw new Error('no facts');
    const { repos } = await createTestRepositories();
    await repos.historyTransfer.mergeCatalog([
      { ...facts, typeLine: 'Newer', updatedAt: '2999-01-01T00:00:00.000Z' },
    ]);
    await repos.historyTransfer.mergeCatalog([facts]);
    expect((await repos.catalog.getMany(['sol ring'])).get('sol ring')?.typeLine).toBe('Newer');
    await repos.historyTransfer.mergeCatalog([
      { ...facts, typeLine: 'Newest', updatedAt: '3000-01-01T00:00:00.000Z' },
    ]);
    expect((await repos.catalog.getMany(['sol ring'])).get('sol ring')?.typeLine).toBe('Newest');
  });
});

describe('mergeCatalog', () => {
  it('overwrites every card-fact column of card_catalog when newer facts arrive', async () => {
    const source = await sourceDeck();
    const [facts] = await source.repos.historyTransfer.readCatalog(['sol ring']);
    if (!facts) throw new Error('no facts');
    const { db, repos } = await createTestRepositories();
    await repos.historyTransfer.mergeCatalog([facts]);

    // The fact columns are whatever card_catalog has besides its key and `updated_at`, so a
    // column added to the table later is covered without touching this test.
    const factFields = Object.keys(getTableColumns(cardCatalog)).filter(
      (field) => !['workspaceId', 'key', 'updatedAt'].includes(field),
    );
    expect(factFields).toHaveLength(8);
    const newer: Record<string, unknown> = { ...facts, updatedAt: '2999-01-01T00:00:00.000Z' };
    for (const field of factFields) {
      const value = (facts as Record<string, unknown>)[field];
      newer[field] =
        typeof value === 'number' ? value + 1 : `${typeof value === 'string' ? value : 'none'} (newer)`;
    }
    await repos.historyTransfer.mergeCatalog([newer as typeof facts]);

    const [stored] = await db.select().from(cardCatalog).where(eq(cardCatalog.key, 'sol ring'));
    for (const field of factFields) {
      expect(stored, field).toHaveProperty(field, newer[field]);
    }
    expect(stored?.updatedAt).toBe('2999-01-01T00:00:00.000Z');
  });
});

describe('batchBySize', () => {
  it('batches by row count and by bytes, sending a single large row alone', () => {
    const many = Array.from({ length: TRANSFER_BATCH_ROWS + 1 }, (_, index) => `h${index}`);
    expect(batchBySize(many, new Map()).map((batch) => batch.length)).toEqual([TRANSFER_BATCH_ROWS, 1]);
    const sizes = new Map([
      ['a', TRANSFER_BATCH_BYTES - 10],
      ['b', 20],
      ['c', TRANSFER_BATCH_BYTES * 2],
      ['d', 1],
    ]);
    expect(batchBySize(['a', 'b', 'c', 'd'], sizes)).toEqual([['a'], ['b'], ['c'], ['d']]);
    expect(batchBySize([], sizes)).toEqual([]);
  });
});
