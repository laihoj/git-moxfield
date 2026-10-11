import { describe, expect, it } from 'vitest';

import {
  CARD_TYPE_GROUP_PLURALS,
  CARD_TYPE_GROUPS,
  cardTypeGroup,
  PRIMARY_TYPE_PRECEDENCE,
} from './card-types';

describe('card type vocabulary', () => {
  it('classifies in a different order than it displays, over the same types', () => {
    expect([...PRIMARY_TYPE_PRECEDENCE].sort()).toEqual([...CARD_TYPE_GROUPS].sort());
    expect(PRIMARY_TYPE_PRECEDENCE).not.toEqual([...CARD_TYPE_GROUPS]);
    // Land is classified before Instant, Sorcery, Artifact and Enchantment but listed last.
    expect(PRIMARY_TYPE_PRECEDENCE.indexOf('Land')).toBeLessThan(PRIMARY_TYPE_PRECEDENCE.indexOf('Artifact'));
    expect(CARD_TYPE_GROUPS.at(-1)).toBe('Land');
  });

  it('has a heading for every group and for Other', () => {
    expect(Object.keys(CARD_TYPE_GROUP_PLURALS).sort()).toEqual([...CARD_TYPE_GROUPS, 'Other'].sort());
  });

  it('groups a stored primary type, folding anything else into Other', () => {
    expect(cardTypeGroup('Creature')).toBe('Creature');
    expect(cardTypeGroup('Land')).toBe('Land');
    expect(cardTypeGroup('Scheme')).toBe('Other');
    expect(cardTypeGroup('creature')).toBe('Other');
    expect(cardTypeGroup('')).toBe('Other');
  });
});
