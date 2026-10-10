/** Line-based primer diff types (unified-diff style hunks). */

export type PrimerLineType = 'context' | 'add' | 'remove';

export interface PrimerDiffLine {
  type: PrimerLineType;
  text: string;
  /** 1-based line number in the old text (absent for `add`). */
  oldNumber?: number;
  /** 1-based line number in the new text (absent for `remove`). */
  newNumber?: number;
}

export interface PrimerHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: PrimerDiffLine[];
}

export interface PrimerDiff {
  addedLines: number;
  removedLines: number;
  hunks: PrimerHunk[];
  /** True when one side is `null` (primer not captured); hunks are then empty. */
  unknown: boolean;
}
