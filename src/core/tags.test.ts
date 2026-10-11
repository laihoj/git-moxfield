import { describe, expect, it } from 'vitest';

import { MAX_VERSION_TAG_LENGTH, normalizeTagInput, normalizeVersionTag, tagProblem } from './tags';

describe('normalizeVersionTag', () => {
  it.each([
    ['tournament', 'tournament'],
    ['  Tournament ', 'tournament'],
    ['Top \t  8', 'top 8'],
    ['Pre-Ban_v1.2', 'pre-ban_v1.2'],
    ['Présence', 'présence'],
    ['ÉTÉ', 'été'],
    ['東京 2026', '東京 2026'],
    ['x'.repeat(MAX_VERSION_TAG_LENGTH), 'x'.repeat(MAX_VERSION_TAG_LENGTH)],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeVersionTag(input)).toEqual({ ok: true, name: expected });
  });

  it.each([
    ['', 'Enter a tag.'],
    ['   ', 'Enter a tag.'],
    ['x'.repeat(MAX_VERSION_TAG_LENGTH + 1), 'at most 40'],
    ['tournament/finals', 'may contain'],
    ['stable!', 'may contain'],
    ['🔥', 'may contain'],
    ['...', 'may contain'],
    ['-_-', 'may contain'],
  ])('rejects %j', (input, reason) => {
    const result = normalizeVersionTag(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });
});

describe('normalizeTagInput and tagProblem (what the editors preview)', () => {
  it('previews the stored form without judging it', () => {
    expect(normalizeTagInput('  Pre   Ban ')).toBe('pre ban');
    expect(normalizeTagInput('   ')).toBe('');
  });

  it('agrees with normalizeVersionTag about every input', () => {
    for (const input of ['tournament', '', '  ', 'x'.repeat(41), 'a/b', '🔥', 'Top 8']) {
      const result = normalizeVersionTag(input);
      expect(tagProblem(normalizeTagInput(input))).toBe(result.ok ? null : result.reason);
    }
  });
});
