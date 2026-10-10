/**
 * Line-based primer diff.
 *
 * Primers are markdown documents, so they are compared line by line like `git diff`:
 * {@link primerLineDiff} produces unified-diff style hunks with 1-based line numbers
 * for the UI, and {@link primerChange} produces the summary stored in a deck diff.
 * Both use the same line comparison, so their counts always agree.
 *
 * Line splitting accepts LF, CRLF and lone CR, and a trailing line terminator does
 * not start an extra empty line: `"a\nb\n"` and `"a\nb"` both consist of the lines
 * `a` and `b`. Canonical primers (see `normalizePrimer`) always use LF and end with
 * exactly one newline, so this only matters for non-canonical input.
 */
import { diffArrays } from 'diff';

import type { PrimerChange } from '../diff/types';
import type { PrimerDiff, PrimerDiffLine, PrimerHunk } from './types';

/** Unchanged lines shown around each change when no `context` option is given. */
export const DEFAULT_PRIMER_CONTEXT = 3;

export interface PrimerDiffOptions {
  /**
   * Unchanged lines shown before and after each change (default 3). Changes closer
   * than `2 * context` lines share a hunk. `Infinity` yields a single hunk covering
   * the whole document.
   */
  context?: number;
}

/**
 * Computes a line diff of two primers with hunks.
 *
 * When either side is `null` (primer not captured) the result is `unknown` with zero
 * counts and no hunks: a missing primer is never treated as a deletion. Identical
 * texts produce zero counts and no hunks.
 *
 * Hunk headers follow the unified diff convention: `oldStart`/`newStart` are the
 * 1-based numbers of the first line of the hunk on that side, or, when the hunk has
 * no lines on that side, the number of the line it follows (`0` at the start).
 *
 * @throws {RangeError} when `options.context` is not a non-negative integer or `Infinity`.
 */
export function primerLineDiff(
  before: string | null,
  after: string | null,
  options: PrimerDiffOptions = {},
): PrimerDiff {
  const context = resolveContext(options.context);
  if (before === null || after === null) return { addedLines: 0, removedLines: 0, hunks: [], unknown: true };
  const lines = diffPrimerLines(before, after);
  const { addedLines, removedLines } = countChangedLines(lines);
  const hunks = addedLines + removedLines === 0 ? [] : buildHunks(lines, context);
  return { addedLines, removedLines, hunks, unknown: false };
}

/**
 * Summarizes a primer change for a deck diff. Directional, so that a primer that could
 * not be captured never hides one that was:
 *
 * - `unknown` when `after` is `null` (a failed primer fetch is never a change, and never
 *   a deletion), or when only `before` is `null` and `after` has no lines (learning that
 *   the deck has no primer records nothing);
 * - `captured` when only `before` is `null` and `after` has text;
 * - otherwise `unchanged` when the line sequences are equal, or `changed` with the same
 *   added/removed line counts as {@link primerLineDiff}.
 */
export function primerChange(before: string | null, after: string | null): PrimerChange {
  if (after === null) return { status: 'unknown' };
  if (before === null) return splitLines(after).length === 0 ? { status: 'unknown' } : { status: 'captured' };
  if (before === after) return { status: 'unchanged' };
  const { addedLines, removedLines } = countChangedLines(diffPrimerLines(before, after));
  return addedLines + removedLines === 0
    ? { status: 'unchanged' }
    : { status: 'changed', addedLines, removedLines };
}

function resolveContext(context: number | undefined): number {
  if (context === undefined) return DEFAULT_PRIMER_CONTEXT;
  if (context === Number.POSITIVE_INFINITY || (Number.isInteger(context) && context >= 0)) return context;
  throw new RangeError(`Primer diff context must be a non-negative integer, got ${String(context)}`);
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Work budget for diffing the edited region. Myers' algorithm costs about (N + M) * D
 * line comparisons for N + M lines and edit distance D, so the edit distance searched
 * is capped at budget / (N + M). Past that cap the region is shown as one full
 * replacement: a valid, but not minimal, edit script. The budget is deterministic,
 * unlike a timeout, so {@link primerChange} and {@link primerLineDiff} always agree
 * and a diff never depends on machine load. The worst case takes tens of milliseconds.
 */
const MAX_LINE_DIFF_WORK = 3_000_000;

/**
 * Edit script between two texts as numbered lines. Within each block of consecutive
 * changes, removals precede additions (as in `git diff`). Common leading and trailing
 * lines are matched up front so the diff cost scales with the size of the edited
 * region rather than the whole document, and the work on that region is bounded by
 * {@link MAX_LINE_DIFF_WORK}: a region edited too heavily to diff within the budget
 * is reported as all its old lines removed and all its new lines added.
 */
function diffPrimerLines(before: string, after: string): PrimerDiffLine[] {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);

  let prefix = 0;
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = maxPrefix - prefix;
  while (
    suffix < maxSuffix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const result: PrimerDiffLine[] = [];
  let oldNumber = 1;
  let newNumber = 1;
  const pushContext = (text: string): void => {
    result.push({ type: 'context', text, oldNumber: oldNumber++, newNumber: newNumber++ });
  };

  for (const text of oldLines.slice(0, prefix)) pushContext(text);

  let removed: string[] = [];
  let added: string[] = [];
  const flushChanges = (): void => {
    for (const text of removed) result.push({ type: 'remove', text, oldNumber: oldNumber++ });
    for (const text of added) result.push({ type: 'add', text, newNumber: newNumber++ });
    removed = [];
    added = [];
  };

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const parts = (oldMiddle.length === 0 || newMiddle.length === 0
    ? undefined
    : diffArrays(oldMiddle, newMiddle, {
        maxEditLength: Math.floor(MAX_LINE_DIFF_WORK / (oldMiddle.length + newMiddle.length)),
      })) ?? [
    { removed: true, added: false, value: oldMiddle },
    { removed: false, added: true, value: newMiddle },
  ];
  for (const part of parts) {
    if (part.removed) {
      for (const text of part.value) removed.push(text);
    } else if (part.added) {
      for (const text of part.value) added.push(text);
    } else {
      flushChanges();
      for (const text of part.value) pushContext(text);
    }
  }
  flushChanges();

  for (const text of oldLines.slice(oldLines.length - suffix)) pushContext(text);
  return result;
}

function countChangedLines(lines: readonly PrimerDiffLine[]): { addedLines: number; removedLines: number } {
  let addedLines = 0;
  let removedLines = 0;
  for (const line of lines) {
    if (line.type === 'add') addedLines++;
    else if (line.type === 'remove') removedLines++;
  }
  return { addedLines, removedLines };
}

/** Groups an edit script into hunks with `context` unchanged lines around changes. */
function buildHunks(lines: readonly PrimerDiffLine[], context: number): PrimerHunk[] {
  const ranges: { start: number; end: number }[] = [];
  let index = 0;
  while (index < lines.length) {
    while (index < lines.length && lines[index]?.type === 'context') index++;
    if (index >= lines.length) break;

    let lastChange = index;
    let cursor = index + 1;
    while (cursor < lines.length) {
      if (lines[cursor]?.type !== 'context') {
        lastChange = cursor++;
        continue;
      }
      let runEnd = cursor;
      while (runEnd < lines.length && lines[runEnd]?.type === 'context') runEnd++;
      // A gap of at most 2 * context unchanged lines keeps both changes in one hunk.
      if (runEnd >= lines.length || runEnd - cursor > 2 * context) break;
      cursor = runEnd;
    }

    const start = Math.max(0, index - context);
    const end = Math.min(lines.length, lastChange + 1 + context);
    ranges.push({ start, end });
    index = end;
  }

  const hunks: PrimerHunk[] = [];
  let oldSeen = 0;
  let newSeen = 0;
  let position = 0;
  for (const { start, end } of ranges) {
    for (; position < start; position++) {
      const line = lines[position];
      if (line?.type !== 'add') oldSeen++;
      if (line?.type !== 'remove') newSeen++;
    }
    const hunkLines = lines.slice(start, end).map((line) => ({ ...line }));
    let oldLines = 0;
    let newLines = 0;
    for (const line of hunkLines) {
      if (line.type !== 'add') oldLines++;
      if (line.type !== 'remove') newLines++;
    }
    hunks.push({
      oldStart: oldLines > 0 ? oldSeen + 1 : oldSeen,
      oldLines,
      newStart: newLines > 0 ? newSeen + 1 : newSeen,
      newLines,
      lines: hunkLines,
    });
    oldSeen += oldLines;
    newSeen += newLines;
    position = end;
  }
  return hunks;
}
