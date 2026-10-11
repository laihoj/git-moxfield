import { MINUS_SIGN } from '@/lib/format';

/**
 * The primer's changed lines as colored counters, worded like the summary chip
 * (`+14 / −6 lines`), with `added` and `removed` spoken for screen readers.
 */
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
