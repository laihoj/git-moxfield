import { describe, expect, it } from 'vitest';

import {
  codePointLength,
  foldInlineText,
  joinList,
  normalizeInlineText,
  pluralize,
  truncateWithEllipsis,
  upperFirst,
} from './text';

describe('pluralize', () => {
  it('uses the singular only for exactly one', () => {
    expect(pluralize(1, 'card')).toBe('1 card');
    expect(pluralize(0, 'card')).toBe('0 cards');
    expect(pluralize(2, 'card')).toBe('2 cards');
    expect(pluralize(-1, 'card')).toBe('-1 cards');
  });

  it('takes an irregular or conjugated plural', () => {
    expect(pluralize(2, 'copy', 'copies')).toBe('2 copies');
    expect(pluralize(1, 'deck conflicts', 'decks conflict')).toBe('1 deck conflicts');
    expect(pluralize(3, 'deck conflicts', 'decks conflict')).toBe('3 decks conflict');
  });
});

describe('joinList', () => {
  it.each([
    [[], ''],
    [['a'], 'a'],
    [['a', 'b'], 'a and b'],
    [['a', 'b', 'c'], 'a, b and c'],
  ])('%j → %j', (items, expected) => {
    expect(joinList(items)).toBe(expected);
  });
});

describe('upperFirst', () => {
  it('capitalizes the first character only', () => {
    expect(upperFirst('mainboard')).toBe('Mainboard');
    expect(upperFirst('already Upper')).toBe('Already Upper');
    expect(upperFirst('')).toBe('');
    expect(upperFirst('élan')).toBe('Élan');
  });
});

describe('codePointLength', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(codePointLength('')).toBe(0);
    expect(codePointLength('abc')).toBe(3);
    expect(codePointLength('😀😀')).toBe(2);
    expect('😀😀').toHaveLength(4);
  });
});

describe('normalizeInlineText and foldInlineText', () => {
  it('composes, collapses whitespace runs and trims', () => {
    expect(normalizeInlineText('  Café \t au\n lait  ')).toBe('Café au lait');
    expect(normalizeInlineText(' ')).toBe('');
  });

  it('folds case on top of that', () => {
    expect(foldInlineText('  Blue   FARM ')).toBe('blue farm');
    expect(foldInlineText('Café')).toBe(foldInlineText('CAFÉ'));
  });
});

describe('truncateWithEllipsis', () => {
  it('returns text that fits unchanged', () => {
    expect(truncateWithEllipsis('short', 5)).toBe('short');
    expect(truncateWithEllipsis('', 0)).toBe('');
  });

  it('cuts to max - 1 units, trims, and adds the ellipsis', () => {
    expect(truncateWithEllipsis('Add three cards', 10)).toBe('Add three…');
    expect(truncateWithEllipsis('Add three cards', 11)).toBe('Add three…');
    expect(truncateWithEllipsis('abcdefgh', 4)).toBe('abc…');
  });

  it('never leaves half of a surrogate pair at the cut', () => {
    const cut = truncateWithEllipsis('ab😀cd', 4);
    expect(cut).toBe('ab…');
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});
