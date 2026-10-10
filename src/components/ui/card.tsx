import clsx from 'clsx';
import type { ComponentPropsWithoutRef, ElementType, ReactNode } from 'react';

export interface CardProps extends ComponentPropsWithoutRef<'div'> {
  /** Element to render; `section` when the card has its own heading. */
  as?: ElementType;
  /** Removes the inner padding (for edge-to-edge lists). */
  flush?: boolean;
}

/** Raised surface with 12px radius, the basic building block of every page. */
export function Card({ as: Component = 'div', flush = false, className, children, ...props }: CardProps) {
  return (
    <Component
      className={clsx(
        'rounded-xl border border-border bg-surface shadow-card',
        !flush && 'p-4 md:p-5',
        className,
      )}
      {...props}
    >
      {children}
    </Component>
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  /** Heading level; defaults to `h2`. */
  level?: 'h2' | 'h3';
  id?: string;
  description?: ReactNode;
  /** Right-aligned actions (buttons, links). */
  actions?: ReactNode;
  className?: string;
}

/** Title row of a card or page section, with optional description and actions. */
export function CardHeader({ title, level = 'h2', id, description, actions, className }: CardHeaderProps) {
  const Heading = level;
  return (
    <div className={clsx('flex flex-wrap items-start justify-between gap-x-4 gap-y-2', className)}>
      <div className="min-w-0 flex-1">
        <Heading id={id} className="text-base font-semibold tracking-tight text-fg">
          {title}
        </Heading>
        {description !== undefined && <div className="mt-0.5 text-sm text-muted">{description}</div>}
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Small uppercase label above a group of rows (`MAINBOARD`, `MOVED`). */
export function Overline({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <p id={id} className={clsx('text-xs font-semibold tracking-wide text-muted uppercase', className)}>
      {children}
    </p>
  );
}
