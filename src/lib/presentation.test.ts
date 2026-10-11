import { describe, expect, it } from 'vitest';

import {
  currentFetchError,
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

describe('currentFetchError', () => {
  const error = {
    code: 'blocked',
    message: 'Blocked.',
    at: '2026-10-09T12:00:00.000Z',
    retryAfterSeconds: null,
  } as const;

  it('is the error when there is no observation yet', () => {
    expect(currentFetchError({ lastFetchError: error, working: null })).toBe(error);
  });

  it('is the error only when it is later than the latest observation', () => {
    expect(
      currentFetchError({ lastFetchError: error, working: { fetchedAt: '2026-10-09T11:00:00.000Z' } }),
    ).toBe(error);
    expect(currentFetchError({ lastFetchError: error, working: { fetchedAt: error.at } })).toBeNull();
    expect(
      currentFetchError({ lastFetchError: error, working: { fetchedAt: '2026-10-09T13:00:00.000Z' } }),
    ).toBeNull();
  });

  it('is null without an error', () => {
    expect(currentFetchError({ lastFetchError: null, working: null })).toBeNull();
  });
});
