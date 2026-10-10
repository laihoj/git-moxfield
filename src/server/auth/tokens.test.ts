import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { BOOKMARKLET_KEY_PATTERN } from '@/integrations/moxfield/capture-protocol';

import { generateToken, hashToken, parseToken, TOKEN_PREFIXES, type TokenKind } from './tokens';

const KINDS = Object.keys(TOKEN_PREFIXES) as TokenKind[];

describe('generateToken', () => {
  it.each(KINDS)('makes %s tokens of a type prefix and 256 random bits in base64url', (kind) => {
    const token = generateToken(kind);
    expect(token).toMatch(new RegExp(`^${TOKEN_PREFIXES[kind]}[A-Za-z0-9_-]{43}$`));
    expect(Buffer.from(token.slice(4), 'base64url')).toHaveLength(32);
  });

  it('never repeats itself', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateToken('session')));
    expect(tokens.size).toBe(1000);
  });

  it('uses distinct prefixes, so one kind is never accepted as another', () => {
    expect(new Set(Object.values(TOKEN_PREFIXES)).size).toBe(KINDS.length);
    expect(TOKEN_PREFIXES).toEqual({
      key: 'gmk_',
      session: 'gms_',
      invite: 'gmi_',
      login: 'gml_',
      share: 'gmv_',
    });
  });

  it('makes keys that the bookmarklet protocol accepts', () => {
    for (let i = 0; i < 100; i++) expect(generateToken('key')).toMatch(BOOKMARKLET_KEY_PATTERN);
  });
});

describe('parseToken', () => {
  it.each(KINDS)('accepts a well-formed %s token', (kind) => {
    const token = generateToken(kind);
    expect(parseToken(kind, token)).toBe(token);
  });

  it.each([
    ['another kind', generateToken('session')],
    ['a missing body', 'gmk_'],
    ['one character short', generateToken('key').slice(0, -1)],
    ['one character long', `${generateToken('key')}A`],
    ['padding', `${generateToken('key').slice(0, -1)}=`],
    ['standard base64', `gmk_${'+'.repeat(43)}`],
    ['surrounding space', ` ${generateToken('key')}`],
    ['an upper-case prefix', generateToken('key').replace('gmk_', 'GMK_')],
    ['the empty string', ''],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', { token: generateToken('key') }],
  ])('rejects %s', (_case, value) => {
    expect(parseToken('key', value)).toBeNull();
  });
});

describe('hashToken', () => {
  it('is the SHA-256 hex digest of the full token string', () => {
    const token = generateToken('invite');
    expect(hashToken(token)).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken(generateToken('invite')));
  });
});
