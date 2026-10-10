'use client';

import clsx from 'clsx';
import { Activity, GitCompareArrows, History, LayoutDashboard, Search } from 'lucide-react';
import type { Route } from 'next';
import { useSelectedLayoutSegments } from 'next/navigation';
import type { ComponentType } from 'react';

import { Link } from '@/components/ui/navigation';
import { deckRoutes, type DeckScope } from '@/lib/routes';

type DeckSection = 'overview' | 'history' | 'compare' | 'cards';

interface NavItem {
  id: DeckSection;
  label: string;
  href: Route;
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;
}

/**
 * Active section from the segments below the deck (`/decks/[deckId]` or `/s/[token]`);
 * version pages belong to History. Pages outside the four sections (the owner's Share
 * page) mark none.
 */
function activeSection(segments: readonly string[]): DeckSection | null {
  switch (segments[0]) {
    case undefined:
      return 'overview';
    case 'history':
    case 'versions':
      return 'history';
    case 'compare':
      return 'compare';
    case 'cards':
      return 'cards';
    default:
      return null;
  }
}

/**
 * Deck navigation: Status · History · Compare · Cards. Underlined tabs at the top from
 * `md` up; a fixed bottom bar with icons on small screens (respecting the home
 * indicator's safe area). The bottom bar marks the page with `data-bottom-nav`, which
 * reserves space for it at the end of the page (see globals.css).
 *
 * Share link viewers get the same tabs within the link's pages, with Overview in place
 * of Status: they see committed versions only, never the state of the deck on Moxfield.
 */
export function DeckNav({ scope }: { scope: DeckScope }) {
  const active = activeSection(useSelectedLayoutSegments());
  const routes = deckRoutes(scope);
  const items: NavItem[] = [
    scope.kind === 'owner'
      ? { id: 'overview', label: 'Status', href: routes.overview(), Icon: Activity }
      : { id: 'overview', label: 'Overview', href: routes.overview(), Icon: LayoutDashboard },
    { id: 'history', label: 'History', href: routes.history(), Icon: History },
    { id: 'compare', label: 'Compare', href: routes.compare(), Icon: GitCompareArrows },
    { id: 'cards', label: 'Cards', href: routes.cards(), Icon: Search },
  ];

  return (
    <>
      <nav aria-label="Deck" className="hidden border-b border-border md:block">
        <ul className="-mb-px flex gap-1">
          {items.map(({ id, label, href, Icon }) => (
            <li key={id}>
              <Link
                href={href}
                aria-current={active === id ? 'page' : undefined}
                className={clsx(
                  'flex h-11 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors',
                  active === id
                    ? 'border-accent text-fg'
                    : 'border-transparent text-muted hover:border-border-strong hover:text-fg',
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={clsx('size-4', active === id ? 'text-accent' : 'text-subtle')}
                />
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <nav
        aria-label="Deck"
        data-bottom-nav=""
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md backdrop-saturate-150 md:hidden"
      >
        <ul className="mx-auto grid max-w-lg grid-cols-4">
          {items.map(({ id, label, href, Icon }) => (
            <li key={id}>
              <Link
                href={href}
                aria-current={active === id ? 'page' : undefined}
                className={clsx(
                  'relative flex h-16 flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium transition-colors',
                  active === id ? 'text-accent' : 'text-muted active:text-fg',
                )}
              >
                {active === id && (
                  <span aria-hidden="true" className="absolute top-0 h-0.5 w-8 rounded-full bg-accent" />
                )}
                <Icon aria-hidden="true" className="size-5" />
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
