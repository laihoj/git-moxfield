/**
 * What a card history reads (`DeckHistory.cardHistory`). Remotely every query is a round
 * trip and Turso bills the rows it reads, so the history loads the card's versions from
 * the card index once per name, and full snapshots only where the card enters or leaves
 * the deck: in one round for a card that was never renamed, in a few more (each input
 * still loaded once) for a chain of renames.
 */
import { describe, expect, it } from 'vitest';

import type { CanonicalSnapshot, CardKey } from '@/core/model';
import type { Repositories } from '@/server/repositories';
import { DeckHistory, type HistoryRepositories } from '@/server/services/history';
import { createStaticDeckSourceRegistry } from '@/server/sources';
import { baseDeckSpec, buildSnapshot, type CardSpec } from '@tests/support/builders';
import { commitTestSnapshots, createTestDeck, createTestRepositories } from '@tests/support/db';
import { defined } from '@tests/support/services';

/** The repositories, recording every card index and snapshot lookup the history makes. */
function recording(repos: Repositories) {
  const cardKeys: CardKey[] = [];
  const snapshotBatches: string[][] = [];
  const history: HistoryRepositories = {
    ...repos,
    cardIndex: {
      versionsContainingCard: (deckId, key) => {
        cardKeys.push(key);
        return repos.cardIndex.versionsContainingCard(deckId, key);
      },
      searchCardsInDeck: (...args) => repos.cardIndex.searchCardsInDeck(...args),
    },
    snapshots: {
      get: (hash) => {
        snapshotBatches.push([hash]);
        return repos.snapshots.get(hash);
      },
      getMany: (hashes) => {
        const batch = [...hashes];
        snapshotBatches.push(batch);
        return repos.snapshots.getMany(batch);
      },
    },
  };
  return { history: new DeckHistory(history, createStaticDeckSourceRegistry([])), cardKeys, snapshotBatches };
}

/** A version of the base deck with `extra` added to the mainboard. */
function withMainboard(...extra: CardSpec[]): CanonicalSnapshot {
  const spec = baseDeckSpec();
  return buildSnapshot({
    ...spec,
    zones: { ...spec.zones, mainboard: [...(spec.zones?.mainboard ?? []), ...extra] },
  });
}

describe('card history loading', () => {
  it('reads a card that was never renamed in one round: its versions once, the snapshots where it entered', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    // In v1, cut in v2, back in v3 and v4.
    const commits = await commitTestSnapshots(repos, deck, [
      withMainboard('Grim Tutor'),
      withMainboard(),
      withMainboard('Grim Tutor'),
      withMainboard('2 Grim Tutor'),
    ]);
    const { history, cardKeys, snapshotBatches } = recording(repos);

    const found = defined(await history.cardHistory(deck.id, 'Grim Tutor', null));
    expect(found.history.entries.map((entry) => entry.transition)).toEqual([
      'first-seen',
      'removed',
      'restored',
      'quantity',
    ]);
    expect(cardKeys).toEqual(['grim tutor']);
    // Where it came back (v2 → v3) and its newest version (v4, for its name): one batch.
    expect(snapshotBatches).toEqual([
      expect.arrayContaining(
        [commits[1], commits[2], commits[3]].map((commit) => defined(commit).snapshotHash),
      ),
    ]);
    expect(snapshotBatches[0]).toHaveLength(3);
  });

  it('reads nothing but the card index for a card the deck never had', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    await commitTestSnapshots(repos, deck, [withMainboard(), withMainboard('Grim Tutor')]);
    const { history, cardKeys, snapshotBatches } = recording(repos);

    expect(await history.cardHistory(deck.id, 'Black Lotus', null)).toBeNull();
    expect(cardKeys).toEqual(['black lotus']);
    expect(snapshotBatches).toEqual([]);
  });

  it('follows a chain of renames, loading every name and snapshot once', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos);
    // One card (one Moxfield id) under three names: renamed in v2 and again in v3.
    const card = (name: string): CardSpec => ({ name, ids: { moxfield: 'vial-1' } });
    await commitTestSnapshots(repos, deck, [
      withMainboard(card('Aether Vial Old')),
      withMainboard(card('Aether Vial')),
      withMainboard(card('Aether Vial New')),
      withMainboard(card('Aether Vial New'), 'Grim Tutor'),
    ]);
    const { history, cardKeys, snapshotBatches } = recording(repos);

    const found = defined(await history.cardHistory(deck.id, 'Aether Vial Old', null));
    expect(found.history.key).toBe('aether vial new');
    expect(found.history.name).toBe('Aether Vial New');
    expect(
      found.history.entries.map((entry) => [entry.sequence, entry.transition, entry.renamedFrom]),
    ).toEqual([
      [1, 'first-seen', undefined],
      [2, 'unchanged', { key: 'aether vial old', name: 'Aether Vial Old' }],
      [3, 'unchanged', { key: 'aether vial', name: 'Aether Vial' }],
      [4, 'unchanged', undefined],
    ]);
    expect(cardKeys.sort()).toEqual(['aether vial', 'aether vial new', 'aether vial old']);
    const hashes = snapshotBatches.flat();
    expect(new Set(hashes).size).toBe(hashes.length);

    // Any name of the card gives the same history.
    const byNewest = defined(await history.cardHistory(deck.id, 'Aether Vial New', null));
    expect(byNewest.history).toEqual(found.history);
  });
});
