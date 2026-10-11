import clsx from 'clsx';
import type { ComponentPropsWithoutRef } from 'react';

export interface InlineCodeProps extends ComponentPropsWithoutRef<'code'> {
  /** `tinted` for text on a tinted notice, where the usual chip would not stand out. */
  tone?: 'default' | 'tinted';
}

/** A snippet inside a sentence (`PUBLIC_APP_URL`, `pnpm start:lan`): a small chip. */
export function InlineCode({ tone = 'default', className, ...props }: InlineCodeProps) {
  return (
    <code
      className={clsx(
        'rounded px-1 py-0.5',
        tone === 'default' ? 'bg-surface-2' : 'bg-surface/70',
        className,
      )}
      {...props}
    />
  );
}
