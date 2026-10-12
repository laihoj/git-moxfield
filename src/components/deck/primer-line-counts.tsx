import { MINUS_SIGN } from '@/lib/format';

/** The primer's changed lines, `+14 / −6 lines` as in the summary chip, with the meaning spoken. */
export function PrimerLineCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="text-sm font-medium tabular">
      <span className="text-add">
        +{added}
        <span className="sr-only"> added</span>
      </span>
      <span className="text-subtle"> / </span>
      <span className="text-remove">
        {MINUS_SIGN}
        {removed}
        <span className="sr-only"> removed</span>
      </span>
      <span className="text-muted"> lines</span>
    </span>
  );
}
