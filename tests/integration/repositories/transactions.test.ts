import { describe, expect, it } from 'vitest';

import { RepositoryError, createRepositories } from '@/server/repositories';
import { baseDeckSpec, buildSnapshot } from '@tests/support/builders';
import { countRows, createTestDeck, createTestRepositories, openTestDatabase } from '@tests/support/db';

describe('repository transactions', () => {
  it('commits every write of the callback and returns its result', () => {
    const { db, repos } = createTestRepositories();

    const hash = repos.transaction((tx) => {
      createTestDeck(tx);
      return tx.snapshots.put(buildSnapshot(baseDeckSpec()));
    });

    expect(repos.snapshots.get(hash)).toEqual(buildSnapshot(baseDeckSpec()));
    expect(countRows(db, 'decks')).toBe(1);
  });

  it('rolls back every write when the callback throws', () => {
    const { db, repos } = createTestRepositories();

    expect(() =>
      repos.transaction((tx) => {
        createTestDeck(tx);
        tx.snapshots.put(buildSnapshot(baseDeckSpec()));
        tx.catalog.upsertMany([
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
        throw new Error('abort');
      }),
    ).toThrow('abort');

    for (const table of ['decks', 'branches', 'snapshots', 'snapshot_cards', 'card_catalog']) {
      expect(countRows(db, table)).toBe(0);
    }
  });

  it('rolls back only the inner work of a failed nested transaction', () => {
    const { db, repos } = createTestRepositories();

    repos.transaction((tx) => {
      createTestDeck(tx, { externalId: 'Outer' });
      try {
        tx.transaction((inner) => {
          createTestDeck(inner, { externalId: 'Inner' });
          createTestDeck(inner, { externalId: 'Outer' });
        });
      } catch (error) {
        expect(error).toBeInstanceOf(RepositoryError);
      }
    });

    expect(repos.decks.list().map((d) => d.externalId)).toEqual(['Outer']);
    expect(countRows(db, 'branches')).toBe(1);
  });

  it('keeps the atomicity of single repository calls inside a transaction', () => {
    const { db, repos } = createTestRepositories();
    const deck = createTestDeck(repos);

    repos.transaction((tx) => {
      expect(() => createTestDeck(tx, { externalId: deck.externalId })).toThrow(RepositoryError);
      tx.decks.updateCachedInfo(deck.id, { name: 'Renamed', format: deck.format, url: deck.url });
    });

    expect(repos.decks.getById(deck.id)?.name).toBe('Renamed');
    expect(countRows(db, 'decks')).toBe(1);
  });

  it('refuses asynchronous callbacks', () => {
    const db = openTestDatabase();
    const repos = createRepositories(db);

    expect(() =>
      repos.transaction(async (tx) => {
        createTestDeck(tx);
        await Promise.resolve();
      }),
    ).toThrow(/cannot return a promise/);
    expect(countRows(db, 'decks')).toBe(0);
  });
});
