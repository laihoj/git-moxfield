import * as crypto from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { isAcceptableCaptureOrigin, isValidCaptureToken } from './form-guard';

vi.mock('node:crypto', { spy: true });

const MOXFIELD = 'https://moxfield.com';
const TOKEN = 'c0ffee'.repeat(10) + 'beef';

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

describe('isValidCaptureToken', () => {
  it('accepts exactly the installation token', () => {
    expect(TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(isValidCaptureToken(TOKEN, TOKEN)).toBe(true);
  });

  it.each([
    ['missing', null],
    ['undefined', undefined],
    ['a file upload', new File([TOKEN], 'token.txt')],
    ['empty', ''],
    ['another token', 'f'.repeat(64)],
    ['one character off', `${TOKEN.slice(0, 63)}0`],
    ['a prefix', TOKEN.slice(0, 32)],
    ['longer', `${TOKEN}0`],
    ['padded', ` ${TOKEN}`],
    ['uppercase', TOKEN.toUpperCase()],
  ])('rejects a token that is %s', (_case, candidate) => {
    expect(isValidCaptureToken(candidate, TOKEN)).toBe(false);
  });

  it('fails closed when the expected token is malformed', () => {
    expect(isValidCaptureToken('', '')).toBe(false);
    expect(isValidCaptureToken('short', 'short')).toBe(false);
    expect(isValidCaptureToken(TOKEN.toUpperCase(), TOKEN.toUpperCase())).toBe(false);
  });

  it('compares in constant time, whatever the candidate length', () => {
    const compare = vi.mocked(crypto.timingSafeEqual);
    compare.mockClear();
    for (const candidate of [TOKEN, 'f'.repeat(64), 'x', 'y'.repeat(10_000)])
      isValidCaptureToken(candidate, TOKEN);
    expect(compare).toHaveBeenCalledTimes(4);
    // Fixed-length digests: the comparison never depends on the candidate's length.
    for (const [a, b] of compare.mock.calls) {
      expect(a.byteLength).toBe(32);
      expect(b.byteLength).toBe(32);
    }
  });
});
