import clsx from 'clsx';
import { CircleCheck } from 'lucide-react';

import type { StatusTone } from '@/lib/presentation';

/** The status dot (or check) that precedes a status label. Decorative: the label carries the meaning. */
export function StatusIndicator({ tone, className }: { tone: StatusTone; className?: string }) {
  if (tone === 'success') {
    return <CircleCheck aria-hidden="true" className={clsx('size-4 shrink-0 text-add', className)} />;
  }
  return (
    <span aria-hidden="true" className={clsx('flex size-4 shrink-0 items-center justify-center', className)}>
      <span
        className={clsx(
          'block size-2.5 rounded-full',
          tone === 'accent' && 'bg-accent ring-4 ring-accent/15',
          tone === 'neutral' && 'bg-cosmetic',
          tone === 'pending' && 'border-2 border-subtle',
        )}
      />
    </span>
  );
}
