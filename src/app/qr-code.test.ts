import { create } from 'qrcode';
import { describe, expect, it } from 'vitest';

import { qrCode } from './qr-code';

const LINK = 'https://decks.example.com/signin/gml_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';

/** Dark modules of a path made of `M{x} {y}h{run}v1h-{run}z` rectangles. */
function modulesOf(path: string): Set<string> {
  const dark = new Set<string>();
  for (const [, x, y, run] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
    for (let i = 0; i < Number(run); i++) dark.add(`${Number(x) + i},${y}`);
  }
  return dark;
}

describe('qrCode', () => {
  it('draws exactly the dark modules of the QR code, one rectangle per run', () => {
    const code = qrCode(LINK);
    const { modules } = create(LINK, { errorCorrectionLevel: 'M' });
    expect(code.size).toBe(modules.size);
    expect(code.path).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);

    const expected = new Set<string>();
    for (let y = 0; y < modules.size; y++) {
      for (let x = 0; x < modules.size; x++) if (modules.get(y, x)) expected.add(`${x},${y}`);
    }
    expect(modulesOf(code.path)).toEqual(expected);
    // Runs are merged: fewer rectangles than dark modules.
    expect(code.path.split('M').length - 1).toBeLessThan(expected.size);
  });

  it('is deterministic', () => {
    expect(qrCode(LINK)).toEqual(qrCode(LINK));
  });
});
