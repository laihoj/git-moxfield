'use client';

import clsx from 'clsx';
import { usePathname } from 'next/navigation';

import { Link } from '@/components/ui/navigation';
import { CAPTURE_PAGE_PATH } from '@/integrations/moxfield/capture-protocol';
import { routes } from '@/lib/routes';

/**
 * Header navigation of signed-in users: Decks and Connect Moxfield, with the current
 * section highlighted (neither on the account and admin pages, which the user menu opens).
 */
export function MainNav() {
  const pathname = usePathname();
  const setupActive = pathname.startsWith(routes.setup()) || pathname.startsWith(CAPTURE_PAGE_PATH);
  const decksActive = pathname === routes.home() || pathname.startsWith('/decks');
  const item = (active: boolean): string =>
    clsx(
      'rounded-lg px-3 py-2.5 transition-colors',
      active ? 'text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
    );
  return (
    <nav aria-label="Main" className="flex items-center gap-1 text-sm font-medium">
      <Link
        href={routes.home()}
        aria-current={pathname === routes.home() ? 'page' : undefined}
        className={item(decksActive)}
      >
        Decks
      </Link>
      <Link
        href={routes.setup()}
        aria-current={pathname === routes.setup() ? 'page' : undefined}
        className={item(setupActive)}
      >
        <span className="sm:hidden">Setup</span>
        <span className="hidden sm:inline">Connect Moxfield</span>
      </Link>
    </nav>
  );
}
