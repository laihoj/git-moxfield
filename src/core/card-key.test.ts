import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { cardKey, normalizeCardName } from './card-key';

const LIM_DUL_COMPOSED = 'Lim-D\u00fbl the Necromancer'; // û as one code point
const LIM_DUL_DECOMPOSED = 'Lim-Du\u0302l the Necromancer'; // u + combining circumflex

/** Names biased towards the characters the normalization rules care about. */
const nameArb = fc.string({
  unit: fc.oneof(
    fc.constantFrom(
      ' ',
      '  ',
      '\t',
      '\n',
      '\u00a0', // no-break space
      '/',
      '//',
      "'",
      '\u2019', // ’
      '\u201c', // “
      'u\u0302', // u + combining circumflex
      '\u0130', // İ
      '\u0316', // combining grave accent below
      'A',
    ),
    fc.string({ unit: 'grapheme', minLength: 1, maxLength: 1 }),
  ),
  maxLength: 24,
});

describe('cardKey', () => {
  it('lowercases', () => {
    expect(cardKey('Sol Ring')).toBe('sol ring');
    expect(cardKey('SOL RING')).toBe('sol ring');
  });

  it('maps composed and decomposed Unicode to the same NFC key', () => {
    expect(LIM_DUL_COMPOSED).not.toBe(LIM_DUL_DECOMPOSED);
    expect(cardKey(LIM_DUL_DECOMPOSED)).toBe(cardKey(LIM_DUL_COMPOSED));
    expect(cardKey(LIM_DUL_DECOMPOSED)).toBe('lim-d\u00fbl the necromancer');
  });

  it('preserves diacritics, which are part of official names', () => {
    expect(cardKey(LIM_DUL_COMPOSED)).not.toBe(cardKey('Lim-Dul the Necromancer'));
    expect(cardKey('S\u00e9ance')).toBe('s\u00e9ance');
  });

  it('maps curly quotes and primes to straight quotes', () => {
    expect(cardKey('Thassa\u2019s Oracle')).toBe("thassa's oracle"); // ’
    expect(cardKey('Thassa\u2018s Oracle')).toBe("thassa's oracle"); // ‘
    expect(cardKey('Thassa\u201bs Oracle')).toBe("thassa's oracle"); // ‛
    expect(cardKey('Thassa\u2032s Oracle')).toBe("thassa's oracle"); // ′
    expect(cardKey('\u201cAch! Hans, Run!\u201d')).toBe('"ach! hans, run!"'); // “ ”
    expect(cardKey('\u201fAch! Hans, Run!\u2033')).toBe('"ach! hans, run!"'); // ‟ ″
  });

  it('normalizes split and double-faced card separators', () => {
    const variants = ['Life//Death', 'Life // Death', 'Life  //  Death', 'Life //Death', 'Life///Death'];
    for (const name of variants) expect(cardKey(name)).toBe('life // death');
    expect(cardKey('Birgi, God of Storytelling // Harnfel, Horn of Bounty')).toBe(
      'birgi, god of storytelling // harnfel, horn of bounty',
    );
  });

  it('collapses and trims all kinds of whitespace', () => {
    expect(cardKey('  Sol   Ring\t')).toBe('sol ring');
    expect(cardKey('Sol\nRing')).toBe('sol ring');
    expect(cardKey('Sol\u00a0Ring')).toBe('sol ring');
    expect(cardKey('Life\t//\u00a0Death ')).toBe('life // death');
  });

  it('keeps the empty name empty', () => {
    expect(cardKey('')).toBe('');
    expect(cardKey('   ')).toBe('');
  });

  it('is idempotent and always NFC', () => {
    fc.assert(
      fc.property(nameArb, (name) => {
        const key = cardKey(name);
        expect(cardKey(key)).toBe(key);
        expect(key.normalize('NFC')).toBe(key);
      }),
    );
  });

  it('stays NFC when lowercasing reorders combining marks', () => {
    // İ lowercases to i + U+0307 (combining class 230), which must then be reordered
    // after U+0316 (combining class 220) to be NFC.
    const key = cardKey('\u0130\u0316');
    expect(key).toBe('i\u0316\u0307');
    expect(key).toBe(key.normalize('NFC'));
  });
});

describe('normalizeCardName', () => {
  it('applies the cardKey rules but keeps case', () => {
    expect(normalizeCardName('  Life//Death ')).toBe('Life // Death');
    expect(normalizeCardName('Thassa\u2019s  Oracle')).toBe("Thassa's Oracle");
    expect(normalizeCardName(LIM_DUL_DECOMPOSED)).toBe(LIM_DUL_COMPOSED);
    expect(normalizeCardName('SOL Ring')).toBe('SOL Ring');
  });

  it('agrees with cardKey up to case', () => {
    fc.assert(
      fc.property(nameArb, (name) => {
        expect(cardKey(normalizeCardName(name))).toBe(cardKey(name));
        expect(normalizeCardName(name).toLowerCase().normalize('NFC')).toBe(cardKey(name));
      }),
    );
  });

  it('is idempotent and NFC', () => {
    fc.assert(
      fc.property(nameArb, (name) => {
        const normalized = normalizeCardName(name);
        expect(normalizeCardName(normalized)).toBe(normalized);
        expect(normalized.normalize('NFC')).toBe(normalized);
      }),
    );
  });
});
