'use client';

import clsx from 'clsx';
import { Activity, GitCompareArrows, History, Search } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { useSelectedLayoutSegments } from 'next/navigation';
import type { ComponentType } from 'react';

import { routes } from '@/lib/routes';

type DeckSection = 'status' | 'history' | 'compare' | 'cards';

interface NavItem {
  id: DeckSection;
  label: string;
  href: Route;
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;
}

/** Active section from the segments below `/decks/[deckId]`; version pages belong to History. */
function activeSection(segments: readonly string[]): DeckSection {
  switch (segments[0]) {
    case 'history':
    case 'versions':
      return 'history';
    case 'compare':
      return 'compare';
    case 'cards':
      return 'cards';
    default:
      return 'status';
  }
}

/**
 * Deck navigation: Status · History · Compare · Cards. Underlined tabs at the top from
 * `md` up; a fixed bottom bar with icons on small screens (respecting the home
 * indicator's safe area). The bottom bar marks the page with `data-bottom-nav`, which
 * reserves space for it at the end of the page (see globals.css).
 */
export function DeckNav({ deckId }: { deckId: string }) {
  const active = activeSection(useSelectedLayoutSegments());
  const items: NavItem[] = [
    { id: 'status', label: 'Status', href: routes.deck(deckId), Icon: Activity },
    { id: 'history', label: 'History', href: routes.history(deckId), Icon: History },
    { id: 'compare', label: 'Compare', href: routes.compare(deckId), Icon: GitCompareArrows },
    { id: 'cards', label: 'Cards', href: routes.cards(deckId), Icon: Search },
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
