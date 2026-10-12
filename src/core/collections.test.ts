import { describe, expect, it } from 'vitest';

import { getOrCreate, groupInto } from './collections';

describe('getOrCreate', () => {
  it('creates and stores a missing value once', () => {
    const map = new Map<string, number[]>();
    let created = 0;
    const create = (): number[] => {
      created++;
      return [];
    };
    const first = getOrCreate(map, 'a', create);
    first.push(1);
    expect(getOrCreate(map, 'a', create)).toBe(first);
    expect(created).toBe(1);
    expect(map.get('a')).toEqual([1]);
  });

  it('keeps insertion order', () => {
    const map = new Map<string, number>();
    getOrCreate(map, 'b', () => 1);
    getOrCreate(map, 'a', () => 2);
    getOrCreate(map, 'b', () => 3);
    expect([...map]).toEqual([
      ['b', 1],
      ['a', 2],
    ]);
  });
});

describe('groupInto', () => {
  it('appends to the list of a key, creating it on first use', () => {
    const groups = new Map<string, string[]>();
    groupInto(groups, 'x', 'one');
    groupInto(groups, 'y', 'two');
    groupInto(groups, 'x', 'three');
    expect([...groups]).toEqual([
      ['x', ['one', 'three']],
      ['y', ['two']],
    ]);
  });
});
