import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

export interface DisclosureProps {
  /** Always-visible summary line. */
  summary: ReactNode;
  /** Secondary text on the right of the summary (e.g. a count). */
  meta?: ReactNode;
  defaultOpen?: boolean;
  /** `card` draws its own border; `plain` blends into the surrounding card. */
  variant?: 'card' | 'plain';
  className?: string;
  children: ReactNode;
}

/**
 * Collapsible section built on `<details>`/`<summary>`: keyboard accessible, works
 * without JavaScript, and searchable with the browser's find-in-page.
 */
export function Disclosure({
  summary,
  meta,
  defaultOpen = false,
  variant = 'plain',
  className,
  children,
}: DisclosureProps) {
  return (
    <details
      open={defaultOpen}
      className={clsx(
        'group',
        variant === 'card' && 'rounded-xl border border-border bg-surface shadow-card',
        className,
      )}
    >
      <summary
        className={clsx(
          'flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg text-sm font-medium text-fg select-none [&::-webkit-details-marker]:hidden',
          variant === 'card' ? 'px-4 md:px-5' : 'hover:text-accent',
        )}
      >
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 -rotate-90 text-muted transition-transform group-open:rotate-0"
        />
        <span className="min-w-0 flex-1">{summary}</span>
        {meta !== undefined && (
          <span className="shrink-0 text-xs font-normal text-muted tabular">{meta}</span>
        )}
      </summary>
      <div className={clsx(variant === 'card' ? 'px-4 pb-4 md:px-5 md:pb-5' : 'pt-1 pb-2')}>{children}</div>
    </details>
  );
}
