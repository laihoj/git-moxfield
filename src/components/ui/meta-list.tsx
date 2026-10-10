import clsx from 'clsx';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

export type MetaListProps = ComponentPropsWithoutRef<'ul'>;

/**
 * A line of short facts separated by `·` (`Moxfield edited 3 hours ago · checked 1 min
 * ago`, `Kraum, Ludevic's Opus · Tymna the Weaver`). Use it for every `·`-joined meta
 * line: when the line wraps, items move to the next line as whole units and no
 * separator is left dangling at a line end or start (the `.meta-list` rules in
 * globals.css clip the separator of each line's first item). An item longer than the
 * whole line wraps inside itself.
 *
 * Children are {@link MetaItem}s; `false`/`null` children (conditional items) render
 * nothing. The list clips its left edge, so it must not contain popovers.
 */
export function MetaList({ className, children, ...props }: MetaListProps) {
  return (
    <ul className={clsx('meta-list', className)} {...props}>
      {children}
    </ul>
  );
}

export interface MetaItemProps {
  className?: string;
  children: ReactNode;
}

/** One fact of a {@link MetaList}, preceded by its separator (hidden from screen readers). */
export function MetaItem({ className, children }: MetaItemProps) {
  return (
    <li className={className}>
      <span aria-hidden="true" className="meta-separator">
        ·
      </span>
      {children}
    </li>
  );
}
