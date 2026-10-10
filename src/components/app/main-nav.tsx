'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Header navigation: Decks and Connect Moxfield, with the current section highlighted. */
export function MainNav() {
  const pathname = usePathname();
  const setupActive = pathname.startsWith('/setup') || pathname.startsWith('/capture');
  const decksActive = !setupActive;
  const item = (active: boolean): string =>
    clsx(
      'rounded-lg px-3 py-2.5 transition-colors',
      active ? 'text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
    );
  return (
    <nav aria-label="Main" className="flex items-center gap-1 text-sm font-medium">
      <Link href="/" aria-current={pathname === '/' ? 'page' : undefined} className={item(decksActive)}>
        Decks
      </Link>
      <Link
        href="/setup"
        aria-current={pathname === '/setup' ? 'page' : undefined}
        className={item(setupActive)}
      >
        <span className="sm:hidden">Setup</span>
        <span className="hidden sm:inline">Connect Moxfield</span>
      </Link>
    </nav>
  );
}
