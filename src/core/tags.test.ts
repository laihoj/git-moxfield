import { describe, expect, it } from 'vitest';

import { MAX_VERSION_TAG_LENGTH, normalizeVersionTag, parseTagDraft, rankTagSuggestions } from './tags';

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

describe('parseTagDraft (what the editors preview)', () => {
  it('normalizes a tag the way it will be stored', () => {
    expect(parseTagDraft('  Pre   Ban ')).toEqual({ kind: 'ok', tag: 'pre ban' });
  });

  it('agrees with normalizeVersionTag about every input but the empty one', () => {
    for (const input of ['tournament', 'x'.repeat(41), 'a/b', '🔥', 'Top 8']) {
      const result = normalizeVersionTag(input);
      const draft = parseTagDraft(input);
      expect(
        result.ok ? { kind: 'ok', tag: result.name } : { kind: 'invalid', problem: result.reason },
      ).toEqual(draft);
    }
  });

  it('tells nothing from a tag that cannot be used', () => {
    expect(parseTagDraft('   ')).toEqual({ kind: 'empty' });
    expect(parseTagDraft('#!?')).toEqual({
      kind: 'invalid',
      problem: 'Tags may contain letters, digits, spaces, ".", "-" and "_".',
    });
    expect(parseTagDraft('x'.repeat(MAX_VERSION_TAG_LENGTH + 1))).toMatchObject({ kind: 'invalid' });
  });
});

describe('rankTagSuggestions', () => {
  it('puts the tags on the most versions first, then the most recently used, then by name', () => {
    expect(
      rankTagSuggestions([
        { name: 'alpha', count: 1, lastSequence: 2 },
        { name: 'beta', count: 1, lastSequence: 3 },
        { name: 'gamma', count: 1, lastSequence: 3 },
        { name: 'zeta', count: 2, lastSequence: 2 },
      ]),
    ).toEqual(['zeta', 'beta', 'gamma', 'alpha']);
    expect(rankTagSuggestions([])).toEqual([]);
  });
});
