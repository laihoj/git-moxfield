import { describe, expect, it } from 'vitest';

import { describeRejectedKey, isAcceptableCaptureOrigin } from './form-guard';

const MOXFIELD = 'https://moxfield.com';
const KEY = `gmk_${'A'.repeat(43)}`;

describe('isAcceptableCaptureOrigin', () => {
  it('accepts the configured capture origins', () => {
    expect(isAcceptableCaptureOrigin(MOXFIELD, [MOXFIELD])).toBe(true);
    expect(isAcceptableCaptureOrigin('http://localhost:4010', [MOXFIELD, 'http://localhost:4010'])).toBe(
      true,
    );
  });

  it('accepts the opaque origin that browsers send from https Moxfield to an http git-moxfield', () => {
    expect(isAcceptableCaptureOrigin('null', [MOXFIELD])).toBe(true);
  });

  it('accepts requests without an Origin header', () => {
    expect(isAcceptableCaptureOrigin(null, [MOXFIELD])).toBe(true);
  });

  it.each([
    'https://evil.example',
    'http://moxfield.com',
    'https://moxfield.com.evil.example',
    'https://www.moxfield.com',
    'http://localhost:3000',
    '',
    'NULL',
  ])('rejects any other explicit origin: %j', (origin) => {
    expect(isAcceptableCaptureOrigin(origin, [MOXFIELD])).toBe(false);
  });
});

describe('describeRejectedKey', () => {
  it.each([
    ['missing', null, 'missing'],
    ['undefined', undefined, 'missing'],
    ['a file upload', new File([KEY], 'key.txt'), 'malformed'],
    ['empty', '', 'malformed'],
    ['an old installation capture token', 'c0ffee'.repeat(10) + 'beef', 'malformed'],
    ['a session token', `gms_${'A'.repeat(43)}`, 'malformed'],
    ['a key with a character too many', `${KEY}A`, 'malformed'],
    ['a well-formed key', KEY, 'unknown'],
  ])('classifies %s', (_case, value, expected) => {
    expect(describeRejectedKey(value)).toBe(expected);
  });
});
