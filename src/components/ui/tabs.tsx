import clsx from 'clsx';
import type { Route } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

export interface TabLinkItem {
  id: string;
  label: ReactNode;
  href: Route;
  icon?: ReactNode;
  /** Optional counter shown after the label. */
  count?: number;
}

export interface TabsProps {
  items: readonly TabLinkItem[];
  activeId: string;
  /** Accessible name of the navigation landmark. */
  label: string;
  className?: string;
}

/**
 * Underlined navigation tabs. Each tab is a link (`aria-current="page"` on the active
 * one), so tabs work without JavaScript and are shareable as URLs.
 */
export function Tabs({ items, activeId, label, className }: TabsProps) {
  return (
    <nav aria-label={label} className={clsx('border-b border-border', className)}>
      <ul className="-mb-px flex gap-1 overflow-x-auto [scrollbar-width:none]">
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <li key={item.id} className="shrink-0">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={clsx(
                  'flex h-11 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors',
                  active
                    ? 'border-accent text-fg'
                    : 'border-transparent text-muted hover:border-border-strong hover:text-fg',
                )}
              >
                {item.icon}
                {item.label}
                {item.count !== undefined && (
                  <span className="rounded-full bg-surface-2 px-1.5 text-xs text-muted tabular">
                    {item.count}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
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
