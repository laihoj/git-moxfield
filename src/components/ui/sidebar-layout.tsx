import clsx from 'clsx';
import type { ComponentPropsWithoutRef } from 'react';

/**
 * A page of a main column with a sidebar beside it from `lg` up (20rem wide), and one
 * column below. The deck pages and their loading skeleton share it, so the skeleton
 * keeps the shape of the page it stands in for.
 */
export function SidebarLayout({ className, children, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      className={clsx('grid items-start gap-5 md:gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]', className)}
      {...props}
    >
      {children}
    </div>
  );
}
