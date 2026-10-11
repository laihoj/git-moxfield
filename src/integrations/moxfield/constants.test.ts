import { describe, expect, it } from 'vitest';

import { KNOWN_ZONES } from '@/core/zones';

import { BOARD_TO_ZONE, zoneForBoard } from './constants';

describe('BOARD_TO_ZONE', () => {
  it('maps a Moxfield board to every known zone, so none silently becomes an other: zone', () => {
    expect(new Set(Object.values(BOARD_TO_ZONE))).toEqual(new Set(KNOWN_ZONES));
    for (const zone of KNOWN_ZONES) {
      const board = Object.entries(BOARD_TO_ZONE).find(([, mapped]) => mapped === zone)?.[0];
      expect(board).toBeDefined();
      expect(zoneForBoard(board ?? '')).toBe(zone);
    }
  });

  it('keeps unknown boards as other: zones', () => {
    expect(zoneForBoard('Brand New Board')).toBe('other:brand-new-board');
  });
});
