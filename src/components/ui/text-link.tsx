import clsx from 'clsx';
import { ArrowRight } from 'lucide-react';
import type { Route } from 'next';
import type { ReactNode } from 'react';

import { Link, type LinkProps } from './navigation';

/** The classes of a link in running text; for the `<a>` elements that are not app links. */
export const TEXT_LINK = 'font-medium text-accent hover:underline';

/** A link to a page of the app inside running text. */
export function TextLink({ className, ...props }: LinkProps) {
  return <Link className={clsx(TEXT_LINK, className)} {...props} />;
}

/** A link that goes on to more (`All 12 →`, `View diff →`), tall enough to tap on touch screens. */
export function ArrowLink({ href, children }: { href: Route; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={clsx(TEXT_LINK, 'inline-flex min-h-11 items-center gap-1 text-sm md:min-h-0')}
    >
      {children}
      <ArrowRight aria-hidden="true" className="size-3.5" />
    </Link>
  );
}
