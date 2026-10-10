import clsx from 'clsx';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'add' | 'remove' | 'move' | 'cosmetic' | 'warn' | 'outline';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-muted',
  accent: 'bg-accent-soft text-accent',
  add: 'bg-add-bg text-add',
  remove: 'bg-remove-bg text-remove',
  move: 'bg-move-bg text-move',
  cosmetic: 'bg-cosmetic-bg text-cosmetic',
  warn: 'bg-warn-bg text-warn',
  outline: 'border border-border-strong text-muted',
};

export interface BadgeProps extends ComponentPropsWithoutRef<'span'> {
  tone?: BadgeTone;
  icon?: ReactNode;
  /** `md` is a little larger, for summary chips. */
  size?: 'sm' | 'md';
}

/** Compact label. Meaning must also be carried by its text, never by color alone. */
export function Badge({ tone = 'neutral', icon, size = 'sm', className, children, ...props }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex max-w-full items-center gap-1 rounded-full font-medium whitespace-nowrap tabular',
        size === 'sm' ? 'h-5 px-2 text-xs' : 'h-7 px-2.5 text-[0.8125rem]',
        TONES[tone],
        className,
      )}
      {...props}
    >
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}
