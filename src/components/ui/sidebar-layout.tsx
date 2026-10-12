import clsx from 'clsx';
import type { ComponentPropsWithoutRef } from 'react';

/** A main column and, from `lg` up, a 20rem sidebar; the loading skeleton shares it to keep their shape. */
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
