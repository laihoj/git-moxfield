import { describe, expect, it } from 'vitest';

import { isSequence, MAX_SEQUENCE, parseSequenceText } from './sequence';

describe('isSequence', () => {
  it.each([
    [1, true],
    [12, true],
    [MAX_SEQUENCE, true],
    [0, false],
    [-1, false],
    [MAX_SEQUENCE + 1, false],
    [1.5, false],
    [Number.NaN, false],
    [Number.MAX_SAFE_INTEGER, false],
  ])('%d → %j', (value, expected) => {
    expect(isSequence(value)).toBe(expected);
  });

  it('has nine digits at most', () => {
    expect(MAX_SEQUENCE).toBe(999_999_999);
  });
});

describe('parseSequenceText', () => {
  it.each([
    ['12', { digits: '12', hadPrefix: false, sequence: 12 }],
    ['v12', { digits: '12', hadPrefix: true, sequence: 12 }],
    ['V7', { digits: '7', hadPrefix: true, sequence: 7 }],
    ['012', { digits: '012', hadPrefix: false, sequence: 12 }],
    ['999999999', { digits: '999999999', hadPrefix: false, sequence: 999_999_999 }],
    ['0', { digits: '0', hadPrefix: false, sequence: null }],
    ['v0000', { digits: '0000', hadPrefix: true, sequence: null }],
    ['1000000000', { digits: '1000000000', hadPrefix: false, sequence: null }],
  ])('%s', (text, expected) => {
    expect(parseSequenceText(text)).toEqual(expected);
  });

  it.each(['', 'v', ' 12', '12 ', 'vv1', '1.5', '-1', 'head', 'abc1'])('rejects %j', (text) => {
    expect(parseSequenceText(text)).toBeNull();
  });
});
