import { describe, expect, it } from 'vitest';

import { decodeSegment, parseSequence } from './route-segments';

describe('parseSequence', () => {
  it.each([
    ['1', 1],
    ['v12', 12],
    ['V7', 7],
    ['123456789', 123456789],
  ])('reads %j as %j', (segment, sequence) => {
    expect(parseSequence(segment)).toBe(sequence);
  });

  it.each(['0', 'v0', '', 'v', '-1', '1.5', '1e3', '1234567890', ' 1', 'latest', 'head'])(
    'rejects %j',
    (segment) => {
      expect(parseSequence(segment)).toBeNull();
    },
  );
});

describe('decodeSegment', () => {
  it('decodes percent-encoding and leaves malformed encodings alone', () => {
    expect(decodeSegment('sol%20ring')).toBe('sol ring');
    expect(decodeSegment('plain')).toBe('plain');
    expect(decodeSegment('100%')).toBe('100%');
  });
});
