import clsx from 'clsx';

/** Placeholder block shown while content loads. Decorative: hidden from assistive tech. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={clsx('animate-pulse rounded-md bg-surface-3', className)} />;
}
