import { ChevronLeft } from 'lucide-react';
import type { Route } from 'next';
import type { ReactNode } from 'react';

import { Link } from './navigation';

/**
 * The link above a page that leads back to where it came from (`Cards`, `Back to v3`).
 * It sits `-ml-2` so its text lines up with the page's edge.
 */
export function BackLink({ href, icon, children }: { href: Route; icon?: ReactNode; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 rounded-lg px-2 text-sm font-medium text-muted hover:text-fg md:min-h-9"
    >
      {icon ?? <ChevronLeft aria-hidden="true" className="size-4" />}
      {children}
    </Link>
  );
}
