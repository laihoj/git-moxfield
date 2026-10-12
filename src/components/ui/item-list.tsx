import clsx from 'clsx';
import type { ReactNode } from 'react';

import { MetaList } from './meta-list';

/** The tile an icon sits on: before the text of a row, or at the head of a step or notice. */
export function IconTile({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'accent' | 'solid';
  /** The icon, sized to 16px. */
  children: ReactNode;
}) {
  return (
    <span
      className={clsx(
        'flex size-9 shrink-0 items-center justify-center rounded-lg [&>svg]:size-4',
        tone === 'neutral' && 'bg-surface-2 text-muted',
        tone === 'accent' && 'bg-accent-soft text-accent',
        tone === 'solid' && 'bg-accent text-accent-fg',
      )}
    >
      {children}
    </span>
  );
}

/** A divided list of {@link ItemRow}s inside a flush card; `label` names it for screen readers. */
export function ItemList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={label} className="divide-y divide-border">
      {children}
    </ul>
  );
}

/** The title line of an {@link ItemRow}: the name, and badges that wrap below it on a narrow screen. */
export function ItemTitle({ children, badges }: { children: ReactNode; badges?: ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-fg">
      <span className="min-w-0 break-words">{children}</span>
      {badges}
    </p>
  );
}

interface ItemRowProps {
  /** Rows that start with their title leave it out. */
  icon?: ReactNode;
  /** An {@link ItemTitle}, or a line of the row's own when its anatomy differs. */
  title: ReactNode;
  /** The `MetaItem`s under the title. */
  meta: ReactNode;
  /** Usually an `InlineConfirm`, which takes the whole width when open. */
  actions?: ReactNode;
}

/** One entry of an {@link ItemList}: an icon tile, a title and meta line, and the controls. */
export function ItemRow({ icon, title, meta, actions }: ItemRowProps) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-3 px-4 py-3.5 md:px-5">
      {icon !== undefined && <IconTile>{icon}</IconTile>}
      <div className="min-w-0 flex-1">
        {title}
        <MetaList className="text-xs text-muted">{meta}</MetaList>
      </div>
      {actions}
    </li>
  );
}
