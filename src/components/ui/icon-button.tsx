import clsx from 'clsx';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { Spinner } from './spinner';

export interface IconButtonProps extends Omit<ComponentPropsWithoutRef<'button'>, 'children' | 'aria-label'> {
  /** Accessible name, also shown as a tooltip. Required: the button has no visible text. */
  label: string;
  icon: ReactNode;
  variant?: 'ghost' | 'secondary';
  size?: 'sm' | 'md';
  loading?: boolean;
}

const VARIANTS = {
  ghost: 'text-muted hover:bg-surface-2 hover:text-fg active:bg-surface-3',
  secondary: 'border border-border-strong bg-surface text-fg shadow-card hover:bg-surface-2',
} as const;

/**
 * Square button with only an icon. The visual size stays compact; on small screens the
 * hit area is extended to 44×44px with an invisible pseudo-element.
 */
export function IconButton({
  label,
  icon,
  variant = 'ghost',
  size = 'md',
  loading = false,
  className,
  disabled,
  type = 'button',
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={clsx(
        "relative inline-flex shrink-0 items-center justify-center rounded-lg transition-colors after:absolute after:left-1/2 after:top-1/2 after:size-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-[''] disabled:cursor-not-allowed disabled:opacity-55 md:after:hidden",
        size === 'sm' ? 'size-8' : 'size-11 md:size-10',
        VARIANTS[variant],
        className,
      )}
      {...props}
    >
      {loading ? <Spinner /> : icon}
    </button>
  );
}
