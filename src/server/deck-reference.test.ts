import { describe, expect, it } from 'vitest';

import { describeDeckRef, operatorSiteOrigins, parseDeckReference } from './deck-reference';

const ORIGINS = ['https://moxfield.com'];

describe('parseDeckReference', () => {
  it('reads a Moxfield public id, a URL on the site and a git-moxfield id', () => {
    expect(parseDeckReference(' AbCdEfGhIjKlMnOpQrStUv ', ORIGINS)).toEqual({
      id: 'AbCdEfGhIjKlMnOpQrStUv',
      moxfield: { source: 'moxfield', externalId: 'AbCdEfGhIjKlMnOpQrStUv' },
    });
    expect(
      parseDeckReference('https://moxfield.com/decks/AbCdEfGhIjKlMnOpQrStUv/primer', ORIGINS)?.moxfield,
    ).toEqual({ source: 'moxfield', externalId: 'AbCdEfGhIjKlMnOpQrStUv' });
    // Anything else may still be a git-moxfield deck id.
    expect(parseDeckReference('not a deck', ORIGINS)).toEqual({ id: 'not a deck', moxfield: null });
  });

  it('takes URLs of the other origins that are given', () => {
    const url = 'http://localhost:4010/decks/AbCdEfGhIjKlMnOpQrStUv';
    expect(parseDeckReference(url, ORIGINS)?.moxfield).toBeNull();
    expect(parseDeckReference(url, [...ORIGINS, 'http://localhost:4010'])?.moxfield).toEqual({
      source: 'moxfield',
      externalId: 'AbCdEfGhIjKlMnOpQrStUv',
    });
  });

  it('is null for blank input', () => {
    expect(parseDeckReference('', ORIGINS)).toBeNull();
    expect(parseDeckReference('   ', ORIGINS)).toBeNull();
  });
});

describe('operatorSiteOrigins', () => {
  it('lists the configured site and the default one, once each', () => {
    expect(operatorSiteOrigins({ moxfieldSiteOrigin: 'https://moxfield.com' })).toEqual([
      'https://moxfield.com',
    ]);
    expect(operatorSiteOrigins({ moxfieldSiteOrigin: 'http://localhost:4010' })).toEqual([
      'http://localhost:4010',
      'https://moxfield.com',
    ]);
  });
});

describe('describeDeckRef', () => {
  it('names a deck by its title and source id', () => {
    expect(describeDeckRef({ name: 'Blue Farm', source: 'moxfield', externalId: 'abc' })).toBe(
      '“Blue Farm” (moxfield:abc)',
    );
  });
});
