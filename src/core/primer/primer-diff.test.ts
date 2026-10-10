import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PRIMER_CONTEXT, primerChange, primerLineDiff } from './primer-diff';
import type { PrimerDiff, PrimerDiffLine } from './types';

/** `count` lines `line 1` … `line N`, newline-terminated, with optional replacements. */
function doc(count: number, replace: Record<number, string> = {}): string {
  return Array.from({ length: count }, (_, i) => replace[i + 1] ?? `line ${i + 1}`)
    .map((line) => `${line}\n`)
    .join('');
}

const ctx = (n: number, text = `line ${n}`, newNumber = n): PrimerDiffLine => ({
  type: 'context',
  text,
  oldNumber: n,
  newNumber,
});
const rem = (oldNumber: number, text = `line ${oldNumber}`): PrimerDiffLine => ({
  type: 'remove',
  text,
  oldNumber,
});
const add = (newNumber: number, text: string): PrimerDiffLine => ({ type: 'add', text, newNumber });

describe('primerLineDiff', () => {
  it('is unknown with no hunks when either side is null', () => {
    const unknown = { addedLines: 0, removedLines: 0, hunks: [], unknown: true };
    expect(primerLineDiff(null, 'a\n')).toEqual(unknown);
    expect(primerLineDiff('a\n', null)).toEqual(unknown);
    expect(primerLineDiff(null, null)).toEqual(unknown);
  });

  it('reports nothing for identical texts', () => {
    expect(primerLineDiff(doc(5), doc(5))).toEqual({
      addedLines: 0,
      removedLines: 0,
      hunks: [],
      unknown: false,
    });
    expect(primerLineDiff('', '')).toEqual({ addedLines: 0, removedLines: 0, hunks: [], unknown: false });
  });

  it('builds a hunk with three context lines and 1-based line numbers', () => {
    expect(DEFAULT_PRIMER_CONTEXT).toBe(3);
    expect(primerLineDiff(doc(10), doc(10, { 5: 'line five' }))).toEqual({
      addedLines: 1,
      removedLines: 1,
      unknown: false,
      hunks: [
        {
          oldStart: 2,
          oldLines: 7,
          newStart: 2,
          newLines: 7,
          lines: [ctx(2), ctx(3), ctx(4), rem(5), add(5, 'line five'), ctx(6), ctx(7), ctx(8)],
        },
      ],
    });
  });

  it('tracks diverging old and new line numbers after insertions', () => {
    const before = doc(6);
    const after = 'line 1\nline 2\nnew a\nnew b\nline 3\nline 4\nline 5\nline 6\n';
    expect(primerLineDiff(before, after, { context: 1 })).toEqual({
      addedLines: 2,
      removedLines: 0,
      unknown: false,
      hunks: [
        {
          oldStart: 2,
          oldLines: 2,
          newStart: 2,
          newLines: 4,
          lines: [ctx(2), add(3, 'new a'), add(4, 'new b'), ctx(3, 'line 3', 5)],
        },
      ],
    });
  });

  it('splits distant changes into separate hunks', () => {
    const diff = primerLineDiff(doc(20), doc(20, { 3: 'three', 15: 'fifteen' }));
    expect(diff.hunks).toEqual([
      {
        oldStart: 1,
        oldLines: 6,
        newStart: 1,
        newLines: 6,
        lines: [ctx(1), ctx(2), rem(3), add(3, 'three'), ctx(4), ctx(5), ctx(6)],
      },
      {
        oldStart: 12,
        oldLines: 7,
        newStart: 12,
        newLines: 7,
        lines: [ctx(12), ctx(13), ctx(14), rem(15), add(15, 'fifteen'), ctx(16), ctx(17), ctx(18)],
      },
    ]);
    expect(diff.addedLines).toBe(2);
    expect(diff.removedLines).toBe(2);
  });

  it('merges changes separated by at most twice the context', () => {
    // Six unchanged lines (4–9) between the changes: the context windows touch.
    const merged = primerLineDiff(doc(20), doc(20, { 3: 'three', 10: 'ten' }));
    expect(merged.hunks).toHaveLength(1);
    expect(merged.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 13, newStart: 1, newLines: 13 });

    // Seven unchanged lines (4–10): line 7 would be hidden, so two hunks.
    const split = primerLineDiff(doc(20), doc(20, { 3: 'three', 11: 'eleven' }));
    expect(split.hunks.map(({ oldStart, oldLines }) => [oldStart, oldLines])).toEqual([
      [1, 6],
      [8, 7],
    ]);
  });

  it('supports zero context, using the preceding line number for empty sides', () => {
    expect(primerLineDiff('a\nb\n', 'a\nx\nb\n', { context: 0 }).hunks).toEqual([
      { oldStart: 1, oldLines: 0, newStart: 2, newLines: 1, lines: [add(2, 'x')] },
    ]);
    expect(primerLineDiff('a\nb\n', 'x\na\nb\n', { context: 0 }).hunks).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [add(1, 'x')] },
    ]);
    expect(primerLineDiff('a\nb\nc\n', 'a\nc\n', { context: 0 }).hunks).toEqual([
      { oldStart: 2, oldLines: 1, newStart: 1, newLines: 0, lines: [rem(2, 'b')] },
    ]);
  });

  it('produces a single hunk covering the document with infinite context', () => {
    const diff = primerLineDiff(doc(30), doc(30, { 2: 'two', 29: 'twenty-nine' }), {
      context: Number.POSITIVE_INFINITY,
    });
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 30, newStart: 1, newLines: 30 });
  });

  it('handles an empty primer on either side', () => {
    expect(primerLineDiff('', '# Title\n\nBody\n')).toEqual({
      addedLines: 3,
      removedLines: 0,
      unknown: false,
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 3,
          lines: [add(1, '# Title'), add(2, ''), add(3, 'Body')],
        },
      ],
    });
    expect(primerLineDiff('# Title\nBody\n', '')).toEqual({
      addedLines: 0,
      removedLines: 2,
      unknown: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 0,
          newLines: 0,
          lines: [rem(1, '# Title'), rem(2, 'Body')],
        },
      ],
    });
  });

  it('treats a missing trailing newline and CRLF line endings as the same lines', () => {
    expect(primerLineDiff('a\nb', 'a\nb\n').hunks).toEqual([]);
    expect(primerLineDiff('a\r\nb\r\n', 'a\nb\n').hunks).toEqual([]);
    expect(primerLineDiff('a\rb', 'a\nb\n').hunks).toEqual([]);
  });

  it('keeps blank lines as lines', () => {
    expect(primerLineDiff('\n', '').removedLines).toBe(1);
    expect(primerLineDiff('a\n\n\nb\n', 'a\n\nb\n')).toMatchObject({ addedLines: 0, removedLines: 1 });
  });

  it('lists removals before additions within a block of changes', () => {
    const [hunk] = primerLineDiff('keep\nold 1\nold 2\nkeep too\n', 'keep\nnew 1\nnew 2\nkeep too\n').hunks;
    expect(hunk?.lines.map((line) => line.type)).toEqual([
      'context',
      'remove',
      'remove',
      'add',
      'add',
      'context',
    ]);
  });

  it('rejects invalid context values', () => {
    expect(() => primerLineDiff('a', 'b', { context: -1 })).toThrow(RangeError);
    expect(() => primerLineDiff('a', 'b', { context: 1.5 })).toThrow(RangeError);
    expect(() => primerLineDiff('a', 'b', { context: Number.NaN })).toThrow(RangeError);
    expect(() => primerLineDiff(null, 'b', { context: -1 })).toThrow(RangeError);
  });
});

describe('primerChange', () => {
  it('is unknown when the after side is null: a failed capture is never a change or a deletion', () => {
    expect(primerChange('a\n', null)).toEqual({ status: 'unknown' });
    expect(primerChange('', null)).toEqual({ status: 'unknown' });
    expect(primerChange(null, null)).toEqual({ status: 'unknown' });
  });

  it('is captured when only the before side is null and the after side has text', () => {
    expect(primerChange(null, 'a\n')).toEqual({ status: 'captured' });
    expect(primerChange(null, 'a')).toEqual({ status: 'captured' });
  });

  it('is unknown when only the before side is null and the after side has no lines', () => {
    expect(primerChange(null, '')).toEqual({ status: 'unknown' });
  });

  it('is unchanged for equal texts and for line-equivalent texts', () => {
    expect(primerChange('a\n', 'a\n')).toEqual({ status: 'unchanged' });
    expect(primerChange('', '')).toEqual({ status: 'unchanged' });
    expect(primerChange('a\r\nb', 'a\nb\n')).toEqual({ status: 'unchanged' });
  });

  it('reports line counts consistent with primerLineDiff', () => {
    const pairs: [string, string][] = [
      ['', 'a\nb\n'],
      ['a\nb\n', ''],
      [doc(20), doc(20, { 3: 'three', 15: 'fifteen' })],
      ['# Primer\n\nOld plan.\n', '# Primer\n\nNew plan.\n\n## Mulligans\nKeep fast mana.\n'],
      [doc(8), 'line 1\nline 8\n'],
    ];
    for (const [before, after] of pairs) {
      const { addedLines, removedLines } = primerLineDiff(before, after);
      expect(primerChange(before, after)).toEqual({ status: 'changed', addedLines, removedLines });
    }
    expect(
      primerChange('# Primer\n\nOld plan.\n', '# Primer\n\nNew plan.\n\n## Mulligans\nKeep fast mana.\n'),
    ).toEqual({ status: 'changed', addedLines: 4, removedLines: 1 });
  });
});

describe('bounded line diff work', () => {
  /** Lines 1…count; every even line edited when `edited` is set. */
  function interleaved(count: number, edited: boolean): string {
    return doc(count, edited ? Object.fromEntries(range(2, count, 2).map((n) => [n, `edited ${n}`])) : {});
  }

  function range(from: number, to: number, step: number): number[] {
    return Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
  }

  function timed<T>(run: () => T): { value: T; ms: number } {
    const start = performance.now();
    const value = run();
    return { value, ms: performance.now() - start };
  }

  it('shows a heavily edited region beyond the work budget as one full replacement', () => {
    // Lines 1 and 4001 are unchanged; the 3999 lines in between are the edited region,
    // where 2000 interleaved edits are far beyond the edit distance the budget allows.
    const before = interleaved(4001, false);
    const after = interleaved(4001, true);

    const diff = primerLineDiff(before, after, { context: 1 });
    expect(diff).toMatchObject({ addedLines: 3999, removedLines: 3999, unknown: false });
    expect(diff.hunks).toHaveLength(1);
    const [hunk] = diff.hunks;
    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 4001, newStart: 1, newLines: 4001 });
    expect(hunk?.lines.map((line) => line.type)).toEqual([
      'context',
      ...Array<string>(3999).fill('remove'),
      ...Array<string>(3999).fill('add'),
      'context',
    ]);
    expect(primerChange(before, after)).toEqual({ status: 'changed', addedLines: 3999, removedLines: 3999 });
  });

  it('still finds the exact edits of a few localized changes in a long primer', () => {
    const before = doc(20_000);
    const after = doc(20_000, { 2: 'two', 10_000: 'ten thousand', 19_999: 'almost the end' });

    const diff = primerLineDiff(before, after);
    expect(diff).toMatchObject({ addedLines: 3, removedLines: 3 });
    expect(diff.hunks.map(({ oldStart, newStart }) => [oldStart, newStart])).toEqual([
      [1, 1],
      [9997, 9997],
      [19_996, 19_996],
    ]);
    expect(primerChange(before, after)).toEqual({ status: 'changed', addedLines: 3, removedLines: 3 });
  });

  it('stays fast when every line of a long primer changes', () => {
    const before = doc(8000);
    const after = before.replaceAll('line', 'row');
    const { value, ms } = timed(() => primerChange(before, after));
    expect(value).toEqual({ status: 'changed', addedLines: 8000, removedLines: 8000 });
    // An unbounded Myers diff takes several seconds here.
    expect(ms).toBeLessThan(1000);
  });
});

/** Applies hunks to the old lines, copying unchanged lines between hunks. */
function applyHunks(oldLines: readonly string[], diff: PrimerDiff): string[] {
  const result: string[] = [];
  let next = 1;
  for (const hunk of diff.hunks) {
    const firstOld = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    for (; next < firstOld; next++) result.push(oldLines[next - 1] ?? '<missing>');
    for (const line of hunk.lines) {
      if (line.type !== 'add') {
        expect(line.oldNumber).toBe(next);
        expect(line.text).toBe(oldLines[next - 1]);
        next++;
      }
      if (line.type !== 'remove') {
        expect(line.newNumber).toBe(result.length + 1);
        result.push(line.text);
      }
    }
  }
  for (; next <= oldLines.length; next++) result.push(oldLines[next - 1] ?? '<missing>');
  return result;
}

describe('primerLineDiff properties', () => {
  const linesArb = fc.array(fc.constantFrom('a', 'b', 'c', ''), { maxLength: 16 });
  const text = (lines: readonly string[]): string => lines.map((line) => `${line}\n`).join('');

  it('hunks reconstruct the new text from the old one, for any context', () => {
    fc.assert(
      fc.property(linesArb, linesArb, fc.nat({ max: 4 }), (oldLines, newLines, context) => {
        const diff = primerLineDiff(text(oldLines), text(newLines), { context });
        expect(applyHunks(oldLines, diff)).toEqual(newLines);
        expect(diff.addedLines - diff.removedLines).toBe(newLines.length - oldLines.length);

        const changeLines = diff.hunks.flatMap((h) => h.lines).filter((l) => l.type !== 'context');
        expect(changeLines.filter((l) => l.type === 'add')).toHaveLength(diff.addedLines);
        expect(changeLines.filter((l) => l.type === 'remove')).toHaveLength(diff.removedLines);
        for (const hunk of diff.hunks) {
          expect(hunk.oldLines).toBe(hunk.lines.filter((l) => l.type !== 'add').length);
          expect(hunk.newLines).toBe(hunk.lines.filter((l) => l.type !== 'remove').length);
          const leading = hunk.lines.findIndex((l) => l.type !== 'context');
          const trailing = [...hunk.lines].reverse().findIndex((l) => l.type !== 'context');
          expect(leading).toBeGreaterThanOrEqual(0);
          expect(leading).toBeLessThanOrEqual(context);
          expect(trailing).toBeLessThanOrEqual(context);
        }
        expect(primerChange(text(oldLines), text(newLines))).toEqual(
          diff.hunks.length === 0
            ? { status: 'unchanged' }
            : { status: 'changed', addedLines: diff.addedLines, removedLines: diff.removedLines },
        );
      }),
      { seed: 20261009, numRuns: 300 },
    );
  });
});
