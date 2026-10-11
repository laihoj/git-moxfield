import clsx from 'clsx';
import type { Route } from 'next';
import type { ReactNode } from 'react';

import { Link } from './navigation';

/** One segment of {@link SegmentedLinks}. */
export interface TabLinkItem {
  id: string;
  label: ReactNode;
  href: Route;
  icon?: ReactNode;
  /** Optional counter shown after the label. */
  count?: number;
}

export interface SegmentedLinksProps {
  items: readonly TabLinkItem[];
  activeId: string;
  label: string;
  /** Stretch segments to fill the width (mobile-friendly). */
  block?: boolean;
  className?: string;
}

/** Pill-shaped segmented control whose segments are links (e.g. `?tab=deck`). */
export function SegmentedLinks({ items, activeId, label, block = false, className }: SegmentedLinksProps) {
  return (
    <nav
      aria-label={label}
      className={clsx(
        'inline-flex rounded-lg border border-border bg-surface-2 p-0.5',
        block && 'flex w-full',
        className,
      )}
    >
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            scroll={false}
            className={clsx(
              'flex h-10 items-center justify-center gap-1.5 rounded-md px-3.5 text-sm font-medium transition-colors md:h-8',
              block && 'flex-1',
              active ? 'bg-surface text-fg shadow-card dark:bg-surface-3' : 'text-muted hover:text-fg',
            )}
          >
            {item.icon}
            {item.label}
            {item.count !== undefined && <span className="text-xs text-subtle tabular">{item.count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
