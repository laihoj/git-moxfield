import { describe, expect, it } from 'vitest';

import { baseWith, buildSnapshot, baseDeckSpec } from '@tests/support/builders';

import { snapshotHash } from './hash';
import {
  DECK_VIEWS,
  DEFAULT_DECK_VIEW,
  isDeckView,
  viewShowsZone,
  viewSnapshot,
  viewSnapshotPair,
  viewZoneQuantities,
} from './deck-view';
import { diffSnapshots } from './diff';
import { snapshotZones } from './canonical';

describe('deck views', () => {
  it('knows exactly two views, MTG being the default', () => {
    expect(DECK_VIEWS).toEqual(['mtg', 'cedh']);
    expect(DEFAULT_DECK_VIEW).toBe('mtg');
    expect(isDeckView('mtg')).toBe(true);
    expect(isDeckView('cedh')).toBe(true);
    for (const value of ['MTG', 'edh', '', null, undefined, 1]) expect(isDeckView(value)).toBe(false);
  });

  it('shows every zone in the MTG view and the played zones only in the cEDH view', () => {
    for (const zone of ['commanders', 'mainboard', 'sideboard', 'considering', 'other:wish-board'] as const) {
      expect(viewShowsZone('mtg', zone)).toBe(true);
    }
    expect(viewShowsZone('cedh', 'commanders')).toBe(true);
    expect(viewShowsZone('cedh', 'companions')).toBe(true);
    expect(viewShowsZone('cedh', 'mainboard')).toBe(true);
    expect(viewShowsZone('cedh', 'sideboard')).toBe(false);
    expect(viewShowsZone('cedh', 'considering')).toBe(false);
    expect(viewShowsZone('cedh', 'tokens')).toBe(false);
    expect(viewShowsZone('cedh', 'other:wish-board')).toBe(false);
  });
});

describe('viewSnapshot', () => {
  it('returns the very snapshot for the MTG view', () => {
    const snapshot = baseWith();
    expect(viewSnapshot(snapshot, 'mtg')).toBe(snapshot);
  });

  it('drops the hidden zones and the card tags of cards left nowhere, keeping everything else', () => {
    const snapshot = buildSnapshot({
      ...baseDeckSpec(),
      cardTags: { 'Dress Down': ['stax'], 'Mnemonic Betrayal': ['wincon'], 'Orcish Bowmasters': ['hate'] },
    });
    const shown = viewSnapshot(snapshot, 'cedh');

    expect(snapshotZones(shown)).toEqual(['commanders', 'mainboard']);
    expect(shown.zones.mainboard).toBe(snapshot.zones.mainboard);
    expect(shown.cardTags).toEqual({ 'dress down': ['stax'] });
    expect(shown.deck).toEqual(snapshot.deck);
    expect(shown.primer).toBe(snapshot.primer);
    // A projection for reading: the stored snapshot is untouched.
    expect(snapshotZones(snapshot)).toEqual(['commanders', 'mainboard', 'sideboard', 'considering']);
    expect(snapshotHash(snapshot)).toBe(
      snapshotHash(buildSnapshot({ ...baseDeckSpec(), cardTags: snapshot.cardTags })),
    );
  });

  it('keeps the tags of a card that is in a shown zone as well as a hidden one', () => {
    const snapshot = buildSnapshot({
      ...baseDeckSpec(),
      zones: { ...baseDeckSpec().zones, considering: ['Dress Down', 'Peer into the Abyss'] },
      cardTags: { 'Dress Down': ['stax'] },
    });
    expect(viewSnapshot(snapshot, 'cedh').cardTags).toEqual({ 'dress down': ['stax'] });
  });
});

describe('viewSnapshotPair', () => {
  it('returns the very snapshots for the MTG view', () => {
    const before = baseWith();
    const after = baseWith();
    expect(viewSnapshotPair(before, after, 'mtg')).toEqual([before, after]);
  });

  it('keeps the tags of a card on both sides while it is shown on either, so a cut is just a cut', () => {
    const tagged = {
      ...baseDeckSpec(),
      cardTags: { 'Dress Down': ['stax'], 'Mnemonic Betrayal': ['wincon'] },
    };
    const before = buildSnapshot(tagged);
    const after = buildSnapshot({
      ...tagged,
      zones: {
        ...tagged.zones,
        mainboard: (tagged.zones?.mainboard ?? []).filter((card) => card !== 'Dress Down'),
        considering: [...(tagged.zones?.considering ?? []), 'Dress Down'],
      },
    });
    const [shownBefore, shownAfter] = viewSnapshotPair(before, after, 'cedh');
    expect(shownBefore.cardTags).toEqual({ 'dress down': ['stax'] });
    expect(shownAfter.cardTags).toEqual({ 'dress down': ['stax'] });
    const diff = diffSnapshots(shownBefore, shownAfter);
    expect(diff.changes.map((change) => change.type)).toEqual(['removed']);
    expect(diff.stats.tagChanges).toBe(0);
    // Projected one by one, the cut would read as a card tag change as well.
    expect(diffSnapshots(viewSnapshot(before, 'cedh'), viewSnapshot(after, 'cedh')).stats.tagChanges).toBe(1);
  });
});

describe('viewZoneQuantities', () => {
  const zones = [
    { zone: 'mainboard', quantity: 1 },
    { zone: 'considering', quantity: 2 },
  ] as const;

  it('keeps every zone in the MTG view (as a copy) and the shown ones in the cEDH view', () => {
    const all = viewZoneQuantities('mtg', zones);
    expect(all).toEqual(zones);
    expect(all).not.toBe(zones);
    expect(viewZoneQuantities('cedh', zones)).toEqual([{ zone: 'mainboard', quantity: 1 }]);
    expect(viewZoneQuantities('cedh', [{ zone: 'sideboard', quantity: 1 }])).toEqual([]);
  });
});
