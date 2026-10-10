import { describe, expect, it } from 'vitest';

import { isValidMoxfieldPublicId, moxfieldDeckUrl, parseMoxfieldDeckInput } from './url';

const ID = 'AbCdEfGhIjKlMnOpQrSt_-';
const CANONICAL = `https://moxfield.com/decks/${ID}`;

describe('parseMoxfieldDeckInput', () => {
  it.each([
    [`https://moxfield.com/decks/${ID}`],
    [`https://www.moxfield.com/decks/${ID}`],
    [`http://moxfield.com/decks/${ID}`],
    [`moxfield.com/decks/${ID}`],
    [`www.moxfield.com/decks/${ID}`],
    [`//moxfield.com/decks/${ID}`],
    [`HTTPS://MOXFIELD.COM/decks/${ID}`],
    [`https://moxfield.com/decks/${ID}/`],
    [`https://moxfield.com/decks/${ID}/primer`],
    [`https://moxfield.com/decks/${ID}/history?x=1`],
    [`https://moxfield.com/decks/${ID}?utm_source=share`],
    [`https://moxfield.com/decks/${ID}#comments`],
    [`https://moxfield.com:443/decks/${ID}`],
    [`  https://moxfield.com/decks/${ID}\n`],
    [ID],
    [`  ${ID}  `],
  ])('accepts %j', (input) => {
    expect(parseMoxfieldDeckInput(input)).toEqual({
      ok: true,
      ref: { source: 'moxfield', externalId: ID },
      canonicalUrl: CANONICAL,
    });
  });

  it.each([
    ['', 'Enter a Moxfield deck URL'],
    ['   ', 'Enter a Moxfield deck URL'],
    ['abc', 'not a valid Moxfield deck id'],
    ['a'.repeat(65), 'not a valid Moxfield deck id'],
    ['bad!id', 'not a valid Moxfield deck id'],
    [`https://evil.example/decks/${ID}`, 'Only decks on moxfield.com'],
    [`https://moxfield.com.evil.example/decks/${ID}`, 'Only decks on moxfield.com'],
    [`https://moxfield.com@evil.example/decks/${ID}`, 'credentials'],
    [`https://user:pw@moxfield.com/decks/${ID}`, 'credentials'],
    [`https://api2.moxfield.com/v3/decks/all/${ID}`, 'Only decks on moxfield.com'],
    [`https://moxfield.com/users/${ID}`, 'does not point to a deck'],
    ['https://moxfield.com/decks/', 'does not point to a deck'],
    ['https://moxfield.com/decks/personal', 'invalid deck id'],
    ['https://moxfield.com/decks/a%20b', 'invalid deck id'],
    ['https://moxfield.com/decks/abc', 'invalid deck id'],
    ['javascript:alert(1)', 'Only http(s)'],
    [`javascript://moxfield.com/decks/${ID}`, 'Only http(s)'],
    [`data:text/html,moxfield.com/decks/${ID}`, 'Only http(s)'],
    [`ftp://moxfield.com/decks/${ID}`, 'Only http(s)'],
    [`https://moxfield.com/decks/${ID} extra`, 'spaces'],
    [`https://moxfield.com/decks/\t${ID}`, 'spaces'],
    ['https://', 'not a valid URL'],
    [`https://moxfield.com/decks/${'x'.repeat(3000)}`, 'too long'],
  ])('rejects %j', (input, reason) => {
    const result = parseMoxfieldDeckInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it('honors a custom site origin (mirrors, mock servers)', () => {
    const origin = 'http://localhost:4010';
    expect(parseMoxfieldDeckInput(`localhost:4010/decks/${ID}`, origin)).toEqual({
      ok: true,
      ref: { source: 'moxfield', externalId: ID },
      canonicalUrl: `http://localhost:4010/decks/${ID}`,
    });
    expect(parseMoxfieldDeckInput(`https://moxfield.com/decks/${ID}`, origin).ok).toBe(false);
    expect(parseMoxfieldDeckInput(ID, origin)).toMatchObject({
      canonicalUrl: `http://localhost:4010/decks/${ID}`,
    });
  });

  it('never throws, even with a misconfigured site origin', () => {
    expect(parseMoxfieldDeckInput(ID, 'not a url')).toEqual({
      ok: false,
      reason: 'The Moxfield site origin is misconfigured.',
    });
  });
});

describe('isValidMoxfieldPublicId', () => {
  it.each([
    [ID, true],
    ['FixtureDeckId_00000001', true],
    ['abcd', true],
    ['a'.repeat(64), true],
    ['abc', false],
    ['a'.repeat(65), false],
    ['has space', false],
    ['dot.ted', false],
    ['personal', false],
    ['Public', false],
    ['', false],
  ])('%j → %s', (id, valid) => {
    expect(isValidMoxfieldPublicId(id)).toBe(valid);
  });
});

describe('moxfieldDeckUrl', () => {
  it('builds the canonical deck URL from the site origin', () => {
    expect(moxfieldDeckUrl(ID)).toBe(CANONICAL);
    expect(moxfieldDeckUrl(ID, 'https://www.moxfield.com/some/path')).toBe(
      `https://www.moxfield.com/decks/${ID}`,
    );
  });
});
