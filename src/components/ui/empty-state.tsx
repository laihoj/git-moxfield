import clsx from 'clsx';
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons or links offering the next step. */
  actions?: ReactNode;
  /** `inline` sits inside a card without its own border. */
  variant?: 'boxed' | 'inline';
  className?: string;
}

/** Friendly placeholder for "nothing here yet" that always points to the next step. */
export function EmptyState({
  icon,
  title,
  description,
  actions,
  variant = 'boxed',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center px-6 py-10 text-center',
        variant === 'boxed' && 'rounded-xl border border-dashed border-border-strong bg-surface',
        className,
      )}
    >
      {icon !== undefined && (
        <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent [&>svg]:size-5">
          {icon}
        </div>
      )}
      <p className="text-base font-semibold text-balance text-fg">{title}</p>
      {description !== undefined && (
        <div className="mt-1 max-w-md text-sm text-balance text-muted">{description}</div>
      )}
      {actions !== undefined && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{actions}</div>
      )}
    </div>
  );
}
