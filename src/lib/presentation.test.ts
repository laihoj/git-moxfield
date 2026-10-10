import { describe, expect, it } from 'vitest';

import {
  deckTitle,
  isUnnamedDeck,
  sharedDeckTitle,
  UNNAMED_DECK_TITLE,
  UNTITLED_DECK_TITLE,
} from './presentation';

describe('deckTitle', () => {
  it('names a never-fetched deck instead of showing its Moxfield id', () => {
    const deck = {
      name: '7O1sCuIti0igU6Us_Jhadg',
      externalId: '7O1sCuIti0igU6Us_Jhadg',
      status: 'never-fetched',
    } as const;
    expect(isUnnamedDeck(deck)).toBe(true);
    expect(deckTitle(deck)).toBe(UNNAMED_DECK_TITLE);
  });

  it('keeps real names, also before the first snapshot', () => {
    expect(deckTitle({ name: 'Blue Farm', externalId: 'abc', status: 'never-fetched' })).toBe('Blue Farm');
    expect(deckTitle({ name: 'abc', externalId: 'abc', status: 'clean' })).toBe('abc');
  });
});

describe('sharedDeckTitle', () => {
  const head = {
    commitId: 'c1',
    shortId: 'c1',
    sequence: 1,
    message: 'Initial version',
    createdAt: '2026-10-01T12:00:00.000Z',
    sourceVersion: null,
    sourceUpdatedAt: null,
  };

  it('names the latest version’s deck', () => {
    expect(sharedDeckTitle({ name: 'Blue Farm', head })).toBe('Blue Farm');
  });

  it('names a deck without versions, whatever its name', () => {
    expect(sharedDeckTitle({ name: '', head: null })).toBe(UNNAMED_DECK_TITLE);
    expect(sharedDeckTitle({ name: 'Blue Farm', head: null })).toBe(UNNAMED_DECK_TITLE);
  });

  it('names a version without a name neutrally, never after the deck on Moxfield', () => {
    expect(sharedDeckTitle({ name: '', head })).toBe(UNTITLED_DECK_TITLE);
    expect(sharedDeckTitle({ name: '  ', head })).toBe(UNTITLED_DECK_TITLE);
    expect(UNTITLED_DECK_TITLE).toBe('Untitled deck');
  });
});
