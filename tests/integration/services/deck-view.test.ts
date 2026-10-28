/**
 * The cEDH view (`@/core/deck-view`) through the services: every read model is computed
 * over the played zones, so a card cut to Considering is a removal, the sideboard and
 * Considering never appear, and what the view leaves out is counted; the status, commits
 * and restore exports follow the full deck.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { snapshotZones } from '@/core/canonical';
import type { DeckServices } from '@/server/services';
import {
  blueFarmSpec,
  commitReviewed,
  committed,
  createServiceHarness,
  defined,
  moveCard,
  publishAndRefresh,
  trackDeck,
  type ServiceHarness,
} from '@tests/support/services';
import type { MoxDeckSpec } from '@tests/support/moxfield-deck-builder';

/**
 *   v1       Blue Farm (Dress Down in the mainboard, Mnemonic Betrayal in Considering)
 *   v2       Dress Down → Considering, Mnemonic Betrayal → mainboard, Abrade into the sideboard
 *   working  only Considering changed: Peer into the Abyss out, Grim Tutor in
 */
async function buildHistory(harness: ServiceHarness): Promise<{ deckId: string; v2: MoxDeckSpec }> {
  const deckId = await trackDeck(harness);
  committed(await commitReviewed(harness, deckId, 'Initial version'));

  let v2 = moveCard(blueFarmSpec({ version: 2 }), 'Dress Down', 'mainboard', 'considering');
  v2 = moveCard(v2, 'Mnemonic Betrayal', 'considering', 'mainboard');
  v2 = { ...v2, sideboard: [...(v2.sideboard ?? []), 'Abrade'] };
  await publishAndRefresh(harness, deckId, v2);
  committed(await commitReviewed(harness, deckId, 'Swap Dress Down for Mnemonic Betrayal'));

  const working = {
    ...v2,
    version: 3,
    considering: [...(v2.considering ?? []).filter((card) => card !== 'Peer into the Abyss'), 'Grim Tutor'],
  };
  await publishAndRefresh(harness, deckId, working);
  return { deckId, v2 };
}

describe('deck services in the cEDH view', () => {
  let harness: ServiceHarness;
  let deckId: string;
  let v2: MoxDeckSpec;
  let cedh: DeckServices;
  let mtg: DeckServices;

  beforeEach(async () => {
    harness = await createServiceHarness();
    ({ deckId, v2 } = await buildHistory(harness));
    cedh = harness.withView('cedh');
    mtg = harness.services;
  });

  it('shows a version’s changes as adds and cuts of the sleeved deck', async () => {
    const detail = defined(await cedh.getVersion(deckId, 2));
    expect(detail.view).toBe('cedh');
    expect(detail.diff.changes.map((change) => `${change.type} ${change.key}`)).toEqual([
      'added mnemonic betrayal',
      'removed dress down',
    ]);
    expect(detail.diff.stats.moves).toEqual([]);
    // Abrade went into the sideboard: left out, and said so.
    expect(detail.hiddenChangeCount).toBe(1);
    expect(detail.version.stats.zones).toEqual([
      { zone: 'mainboard', added: 1, removed: 1, movedIn: 0, movedOut: 0 },
    ]);
    // The Deck tab shows the sleeved deck.
    expect(snapshotZones(detail.snapshot)).toEqual(['commanders', 'mainboard']);
    expect(detail.version.playedCardCount).toBe(
      defined(await mtg.getVersion(deckId, 2)).version.playedCardCount,
    );

    const full = defined(await mtg.getVersion(deckId, 2));
    expect(full.view).toBe('mtg');
    expect(full.hiddenChangeCount).toBe(0);
    expect(full.diff.stats.moves).toHaveLength(2);
    expect(snapshotZones(full.snapshot)).toEqual(['commanders', 'mainboard', 'sideboard', 'considering']);
  });

  it('lists versions with stats over the sleeved deck', async () => {
    const [v2] = await cedh.listVersions(deckId);
    expect(v2?.stats).toEqual({
      zones: [{ zone: 'mainboard', added: 1, removed: 1, movedIn: 0, movedOut: 0 }],
      moves: [],
      printingChanges: 0,
      tagChanges: 0,
      renames: 0,
    });
  });

  it('keeps the status honest when only hidden zones changed, and still suggests a message', async () => {
    const overview = defined(await cedh.getOverview(deckId));
    expect(overview.view).toBe('cedh');
    expect(overview.status).toBe('uncommitted');
    expect(defined(overview.diff).isEmpty).toBe(true);
    expect(overview.hiddenChangeCount).toBe(2);
    expect(overview.workingStats).toEqual({
      zones: [],
      moves: [],
      printingChanges: 0,
      tagChanges: 0,
      renames: 0,
    });
    expect(overview.suggestedMessage).toBe(
      'Add Grim Tutor to Considering; cut Peer into the Abyss from Considering',
    );

    const full = defined(await mtg.getOverview(deckId));
    expect(full.status).toBe('uncommitted');
    expect(full.hiddenChangeCount).toBe(0);
    expect(defined(full.diff).changes).toHaveLength(2);
    expect(full.suggestedMessage).toBe(overview.suggestedMessage);
  });

  it('suggests the sleeving when the mainboard changed, and commits the full deck', async () => {
    const edited = moveCard({ ...v2, version: 4 }, 'Rhystic Study', 'mainboard', 'considering');
    edited.mainboard = [...(edited.mainboard ?? []), 'Final Fortune'];
    await publishAndRefresh(harness, deckId, edited);

    const overview = defined(await cedh.getOverview(deckId));
    expect(overview.suggestedMessage).toBe('Add Final Fortune; cut Rhystic Study');
    // The move to Considering is the cut: nothing is left out.
    expect(overview.hiddenChangeCount).toBe(0);

    const version = committed(
      await commitReviewed(harness, deckId, overview.suggestedMessage, undefined, cedh),
    );
    const stored = defined(await mtg.getVersion(deckId, version.sequence));
    // Everything the deck has is in the version, hidden zones included.
    expect(stored.snapshot.zones.considering?.map((card) => card.name)).toContain('Rhystic Study');
    expect(stored.snapshot.zones.sideboard?.map((card) => card.name)).toContain('Abrade');
  });

  it('compares over the sleeved deck and counts what it leaves out', async () => {
    const comparison = defined(await cedh.compare(deckId, 'v1', 'v2'));
    expect(comparison.view).toBe('cedh');
    expect(comparison.diff.changes.map((change) => change.type)).toEqual(['added', 'removed']);
    expect(comparison.hiddenChangeCount).toBe(1);

    const same = defined(await cedh.compare(deckId, 'v2', 'working'));
    expect(same.diff.isEmpty).toBe(true);
    expect(same.hiddenChangeCount).toBe(2);
  });

  it('tells a card’s history as in and out of the sleeved deck', async () => {
    const { history } = defined(await cedh.cardHistory(deckId, 'Dress Down'));
    expect(history.entries.map((entry) => [entry.sequence, entry.transition, entry.zones])).toEqual([
      [1, 'first-seen', [{ zone: 'mainboard', quantity: 1 }]],
      [2, 'removed', []],
      [null, 'unchanged', []],
    ]);
    expect(history.summary).toMatchObject({ versionsPresent: 1, timesCut: 1, currentZones: [] });

    const full = defined(await mtg.cardHistory(deckId, 'Dress Down')).history;
    expect(full.entries[1]).toMatchObject({
      transition: 'moved',
      zones: [{ zone: 'considering', quantity: 1 }],
    });
    expect(full.summary.versionsPresent).toBe(2);

    // A card that was only ever in Considering has no history in the sleeved deck.
    expect(await cedh.cardHistory(deckId, 'Peer into the Abyss')).toBeNull();
    expect(await mtg.cardHistory(deckId, 'Peer into the Abyss')).not.toBeNull();
  });

  it('searches with the zones of the sleeved deck', async () => {
    const [dressDown] = await cedh.searchCards(deckId, 'dress');
    expect(dressDown).toMatchObject({ key: 'dress down', headZones: [] });
    const [full] = await mtg.searchCards(deckId, 'dress');
    expect(full).toMatchObject({ headZones: [{ zone: 'considering', quantity: 1 }] });
  });

  it('restores the whole deck whatever the view', async () => {
    const [sleeved, full] = await Promise.all([cedh.restoreExport(deckId, 2), mtg.restoreExport(deckId, 2)]);
    expect(defined(sleeved).export).toEqual(defined(full).export);
    expect(JSON.stringify(defined(sleeved).export)).toContain('Abrade');
  });

  it('summarizes decks with the view’s counters and the full deck’s status', async () => {
    const [deck] = await cedh.listDecks();
    expect(deck).toMatchObject({ status: 'uncommitted', workingStats: { zones: [], moves: [] } });
    const [fullDeck] = await mtg.listDecks();
    expect(fullDeck?.workingStats?.zones).toEqual([
      { zone: 'considering', added: 1, removed: 1, movedIn: 0, movedOut: 0 },
    ]);
  });
});
