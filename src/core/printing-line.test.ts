import { describe, expect, it } from 'vitest';

import type { CanonicalPrinting } from './model';
import {
  finishMarker,
  formatCardLines,
  formatPrintingLine,
  linesText,
  type LineFormat,
} from './printing-line';

const LOSSLESS: LineFormat = { unknownFinish: 'verbatim', lang: true, flags: true };
const LOSSY: LineFormat = { unknownFinish: 'omit', lang: false, flags: false };

function printing(extra: Partial<CanonicalPrinting> = {}): CanonicalPrinting {
  return {
    set: 'ltr',
    collectorNumber: '715',
    finish: 'nonfoil',
    lang: 'en',
    quantity: 2,
    ids: {},
    ...extra,
  };
}

describe('finishMarker', () => {
  it.each([
    ['nonfoil', ''],
    ['foil', ' *F*'],
    ['etched', ' *E*'],
  ])('%s is spelled the same in both formats', (finish, marker) => {
    expect(finishMarker(finish, 'verbatim')).toBe(marker);
    expect(finishMarker(finish, 'omit')).toBe(marker);
  });

  it('writes or drops an unknown finish', () => {
    expect(finishMarker('gilded', 'verbatim')).toBe(' *gilded*');
    expect(finishMarker('gilded', 'omit')).toBe('');
  });
});

describe('formatPrintingLine', () => {
  const rich = printing({ finish: 'gilded', lang: 'ja', flags: ['proxy', 'alter'] });

  it('writes everything in the lossless format', () => {
    expect(formatPrintingLine('Sol Ring', rich, LOSSLESS)).toBe(
      '2 Sol Ring (LTR) 715 *gilded* [ja] {proxy,alter}',
    );
  });

  it('writes only the core in the lossy format', () => {
    expect(formatPrintingLine('Sol Ring', rich, LOSSY)).toBe('2 Sol Ring (LTR) 715');
    expect(formatPrintingLine('Sol Ring', printing({ finish: 'foil' }), LOSSY)).toBe(
      '2 Sol Ring (LTR) 715 *F*',
    );
  });
});

describe('formatCardLines and linesText', () => {
  it('writes one line per printing, or the bare quantity without printings', () => {
    const card = {
      name: 'Island',
      quantity: 3,
      printings: [printing({ quantity: 2 }), printing({ quantity: 1 })],
    };
    expect(formatCardLines(card, LOSSLESS)).toEqual(['2 Island (LTR) 715', '1 Island (LTR) 715']);
    expect(formatCardLines({ name: 'Island', quantity: 30, printings: [] }, LOSSLESS, 'Isle')).toEqual([
      '30 Isle',
    ]);
  });

  it('terminates lines with a newline, and writes nothing for none', () => {
    expect(linesText(['a', 'b'])).toBe('a\nb\n');
    expect(linesText([])).toBe('');
  });
});
