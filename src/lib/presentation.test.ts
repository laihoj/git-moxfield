import { describe, expect, it } from 'vitest';

import { deckTitle, isUnnamedDeck, UNNAMED_DECK_TITLE } from './presentation';

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
