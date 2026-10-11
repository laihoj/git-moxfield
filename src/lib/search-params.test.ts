import { describe, expect, it } from 'vitest';

import { searchParamText } from './search-params';

describe('searchParamText', () => {
  it('trims the text', () => {
    expect(searchParamText('  Sol Ring ', 80)).toBe('Sol Ring');
  });

  it.each([undefined, '', '   ', ['a', 'b'], []])('is undefined for %j', (value) => {
    expect(searchParamText(value, 80)).toBeUndefined();
  });

  it('cuts the text to the bound', () => {
    expect(searchParamText('abcdef', 3)).toBe('abc');
  });
});
