import clsx from 'clsx';

import { initials } from '@/lib/accounts';

export interface AvatarProps {
  /** The person's display name; shown as initials. */
  name: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZES = {
  sm: 'size-7 text-[0.6875rem]',
  md: 'size-8 text-xs',
  lg: 'size-11 text-sm',
} as const;

/** A person's initials in an accent circle. Decorative: the name is always written next to it. */
export function Avatar({ name, size = 'md', className }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold tracking-wide text-accent select-none',
        SIZES[size],
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
