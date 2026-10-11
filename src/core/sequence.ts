/**
 * Version sequences: the 1-based number of a committed version (`12`, written `v12`).
 * Routes, server actions and the version reference parser all accept the same range and
 * the same text form, defined here.
 */

/** Most digits a sequence may have; far beyond any real deck history. */
export const MAX_SEQUENCE_DIGITS = 9;

/** The largest sequence (999,999,999). */
export const MAX_SEQUENCE = 10 ** MAX_SEQUENCE_DIGITS - 1;

/** Whether `value` can be a version's sequence: an integer from 1 to {@link MAX_SEQUENCE}. */
export function isSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_SEQUENCE;
}

export interface SequenceText {
  /** The digits as written, without the `v`. */
  digits: string;
  /** Whether the text started with `v`. */
  hadPrefix: boolean;
  /** The sequence, or `null` when the digits are zero or too many. */
  sequence: number | null;
}

/** Parses `12` or `v12` (case-insensitive, no whitespace allowed); `null` for any other text. */
export function parseSequenceText(text: string): SequenceText | null {
  const match = /^(v?)(\d+)$/i.exec(text);
  if (match === null) return null;
  const digits = match[2] ?? '';
  const sequence = Number(digits);
  return {
    digits,
    hadPrefix: match[1] !== '',
    sequence: digits.length <= MAX_SEQUENCE_DIGITS && isSequence(sequence) ? sequence : null,
  };
}
