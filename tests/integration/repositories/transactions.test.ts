import { describe, expect, it } from 'vitest';

import { DatabaseMisuseError } from '@/server/db/transaction';
import { RepositoryError } from '@/server/repositories';
import { baseDeckSpec, buildSnapshot } from '@tests/support/builders';
import { countRows, createTestDeck, createTestRepositories, expectRepositoryError } from '@tests/support/db';

describe('repository transactions', () => {
  it('commits every write of the callback and returns its result', async () => {
    const { db, repos } = await createTestRepositories();

    const hash = await repos.transaction(async (tx) => {
      await createTestDeck(tx);
      return tx.snapshots.put(buildSnapshot(baseDeckSpec()));
    });

    expect(await repos.snapshots.get(hash)).toEqual(buildSnapshot(baseDeckSpec()));
    expect(await countRows(db, 'decks')).toBe(1);
  });

  it('rolls back every write when the callback throws', async () => {
    const { db, repos } = await createTestRepositories();

    await expect(
      repos.transaction(async (tx) => {
        await createTestDeck(tx);
        await tx.snapshots.put(buildSnapshot(baseDeckSpec()));
        await tx.catalog.upsertMany([
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
    ).rejects.toThrow('abort');

    for (const table of ['decks', 'branches', 'snapshots', 'snapshot_cards', 'card_catalog']) {
      expect(await countRows(db, table)).toBe(0);
    }
  });

  it('rolls back only the inner work of a failed nested transaction', async () => {
    const { db, repos } = await createTestRepositories();

    await repos.transaction(async (tx) => {
      await createTestDeck(tx, { externalId: 'Outer' });
      await expectRepositoryError(
        tx.transaction(async (inner) => {
          await createTestDeck(inner, { externalId: 'Inner' });
          await createTestDeck(inner, { externalId: 'Outer' });
        }),
        'conflict',
      );
    });

    expect((await repos.decks.list()).map((d) => d.externalId)).toEqual(['Outer']);
    expect(await countRows(db, 'branches')).toBe(1);
  });

  it('keeps the atomicity of single repository calls inside a transaction', async () => {
    const { db, repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);

    await repos.transaction(async (tx) => {
      await expectRepositoryError(createTestDeck(tx, { externalId: deck.externalId }), 'conflict');
      await tx.decks.updateCachedInfo(deck.id, { name: 'Renamed', format: deck.format, url: deck.url });
    });

    expect((await repos.decks.getById(deck.id))?.name).toBe('Renamed');
    expect(await countRows(db, 'decks')).toBe(1);
  });

  it('serializes concurrent transactions instead of interleaving them', async () => {
    const { repos } = await createTestRepositories();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = repos.transaction(async (tx) => {
      order.push('first started');
      await createTestDeck(tx, { externalId: 'First' });
      await gate;
      order.push('first done');
    });
    const second = repos.transaction(async (tx) => {
      order.push('second started');
      // Sees the first transaction's deck: it only starts once that one committed.
      expect((await tx.decks.list()).map((d) => d.externalId)).toEqual(['First']);
      order.push('second done');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await Promise.all([first, second]);

    expect(order).toEqual(['first started', 'first done', 'second started', 'second done']);
  });

  it('refuses the outer repositories inside a transaction callback', async () => {
    const { db, repos } = await createTestRepositories();

    await expect(
      repos.transaction(async () => {
        // Must be `tx.decks`: the root database is not part of the transaction.
        await createTestDeck(repos);
      }),
    ).rejects.toSatisfy((error: unknown) => error instanceof Error && hasCause(error, DatabaseMisuseError));
    expect(await countRows(db, 'decks')).toBe(0);
  });

  it('reports repository errors thrown inside the callback unchanged', async () => {
    const { repos } = await createTestRepositories();

    const error = await expectRepositoryError(
      repos.transaction((tx) => tx.decks.recordFetchAttempt('missing', '2026-01-01T00:00:00.000Z')),
      'not-found',
    );
    expect(error).toBeInstanceOf(RepositoryError);
  });
});

/** Whether `error` or an error in its cause chain is an instance of `type`. */
function hasCause(error: unknown, type: new (...args: never[]) => Error): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 16 && current !== undefined; depth++) {
    if (current instanceof type) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
