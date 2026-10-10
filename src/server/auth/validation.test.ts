import { describe, expect, it } from 'vitest';

import {
  cleanUserAgent,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_USER_AGENT_LENGTH,
  validateDisplayName,
  validateInviteNote,
  validateKeyLabel,
} from './validation';

describe('validateDisplayName', () => {
  it.each([
    ['Mikko', 'Mikko'],
    ['  Mikko   Virtanen ', 'Mikko Virtanen'],
    ['Zé', 'Zé'],
    ['名前', '名前'],
    ['a'.repeat(MAX_DISPLAY_NAME_LENGTH), 'a'.repeat(MAX_DISPLAY_NAME_LENGTH)],
  ])('accepts %j as %j', (input, value) => {
    expect(validateDisplayName(input)).toEqual({ ok: true, value });
  });

  it.each([
    ['empty', '', 'Enter a name.'],
    ['blank', '   ', 'Enter a name.'],
    ['too long', 'a'.repeat(MAX_DISPLAY_NAME_LENGTH + 1), 'at most 40 characters'],
    ['a bidirectional override', 'Mikko‮admin', 'cannot be shown'],
    ['a zero-width joiner', 'Mi‍kko', 'cannot be shown'],
    ['not a string', 42, 'Enter a name.'],
  ])('rejects %s', (_case, input, message) => {
    const result = validateDisplayName(input);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain(message);
  });
});

describe('validateKeyLabel and validateInviteNote', () => {
  it('requires a key label but not an invite note', () => {
    expect(validateKeyLabel('').ok).toBe(false);
    expect(validateKeyLabel(' Laptop  Chrome ')).toEqual({ ok: true, value: 'Laptop Chrome' });
    expect(validateInviteNote('')).toEqual({ ok: true, value: '' });
    expect(validateInviteNote('for Mikko')).toEqual({ ok: true, value: 'for Mikko' });
    expect(validateInviteNote('x'.repeat(201)).ok).toBe(false);
  });
});

describe('cleanUserAgent', () => {
  it('keeps a normal User-Agent', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';
    expect(cleanUserAgent(ua)).toBe(ua);
  });

  it('removes control characters, truncates and drops empty values', () => {
    expect(cleanUserAgent('a\r\nb\u0000c')).toBe('a b c');
    expect(cleanUserAgent('x'.repeat(1000))).toHaveLength(MAX_USER_AGENT_LENGTH);
    expect(cleanUserAgent('😀'.repeat(300))).toBe('😀'.repeat(MAX_USER_AGENT_LENGTH));
    expect(cleanUserAgent('   ')).toBeNull();
    expect(cleanUserAgent(null)).toBeNull();
    expect(cleanUserAgent(undefined)).toBeNull();
  });
});
