import * as crypto from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { generateSetupCode, normalizeSetupCode, SETUP_CODE_PATTERN, setupCodesEqual } from './setup-code';

vi.mock('node:crypto', { spy: true });

const UNAMBIGUOUS = 'ABCDEFGHJKMNPQRSTWXYZ23456789';

describe('generateSetupCode', () => {
  it('makes XXXX-XXXX-XXXX codes from an alphabet without look-alikes', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateSetupCode();
      expect(code).toMatch(SETUP_CODE_PATTERN);
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(code).not.toMatch(/[01ILOUV]/);
    }
  });

  it('uses every symbol of the alphabet and never repeats a code', () => {
    const codes = Array.from({ length: 2000 }, generateSetupCode);
    expect(new Set(codes).size).toBe(codes.length);
    const symbols = new Set(codes.join('').replaceAll('-', ''));
    expect(Array.from(symbols).sort().join('')).toBe(Array.from(UNAMBIGUOUS).sort().join(''));
  });
});

describe('normalizeSetupCode', () => {
  it.each([
    ['abcd-efgh-jkmn', 'ABCD-EFGH-JKMN'],
    ['ABCDEFGHJKMN', 'ABCD-EFGH-JKMN'],
    ['  abcd efgh   jkmn ', 'ABCD-EFGH-JKMN'],
    ['ab-cd-ef-gh-jk-mn', 'ABCD-EFGH-JKMN'],
    ['2345-6789-ABCD', '2345-6789-ABCD'],
  ])('reads %j as %j', (input, expected) => {
    expect(normalizeSetupCode(input)).toBe(expected);
  });

  it.each([
    ['too short', 'ABCD-EFGH-JKM'],
    ['too long', 'ABCD-EFGH-JKMNP'],
    ['a look-alike O', 'ABCD-EFGH-JKMO'],
    ['a zero', 'ABCD-EFGH-JKM0'],
    ['punctuation', 'ABCD.EFGH.JKMN'],
    ['empty', ''],
    ['very long input', 'A'.repeat(10_000)],
    ['not a string', 123],
  ])('rejects %s', (_case, input) => {
    expect(normalizeSetupCode(input)).toBeNull();
  });
});

describe('setupCodesEqual', () => {
  it('compares codes exactly', () => {
    expect(setupCodesEqual('ABCD-EFGH-JKMN', 'ABCD-EFGH-JKMN')).toBe(true);
    expect(setupCodesEqual('ABCD-EFGH-JKMN', 'ABCD-EFGH-JKMP')).toBe(false);
    expect(setupCodesEqual('ABCD-EFGH-JKMN', '')).toBe(false);
  });

  it('compares fixed-length digests in constant time, whatever the input length', () => {
    const compare = vi.mocked(crypto.timingSafeEqual);
    compare.mockClear();
    for (const candidate of ['ABCD-EFGH-JKMN', 'X', 'Y'.repeat(10_000)])
      setupCodesEqual(candidate, 'ABCD-EFGH-JKMN');
    expect(compare).toHaveBeenCalledTimes(3);
    for (const [a, b] of compare.mock.calls) {
      expect(a.byteLength).toBe(32);
      expect(b.byteLength).toBe(32);
    }
  });
});
