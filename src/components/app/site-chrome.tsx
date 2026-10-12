import type { Route } from 'next';
import type { ReactNode } from 'react';

import { Link } from '@/components/ui/navigation';

import packageJson from '../../../package.json';

import { BrandMark } from './brand-mark';

export interface SiteChromeProps {
  /**
   * Where the wordmark leads: the decks page in the app, the shared deck's overview for
   * share link viewers. Without it the wordmark is not a link (a dead share link has
   * nowhere to go).
   */
  homeHref?: Route;
  /** Right side of the header bar (main navigation and the account menu). */
  actions?: ReactNode;
  /** A full-width notice right below the header bar (the read-only banner of shared decks). */
  banner?: ReactNode;
  children: ReactNode;
}

const WORDMARK =
  '-ml-1 flex items-center gap-2 rounded-lg p-1 text-[0.9375rem] font-semibold tracking-tight text-fg';

/**
 * The frame of every page: the header bar with the wordmark, the main content (`#main`,
 * the target of the root layout's skip link) and the footer. The app and the share link
 * pages fill the header differently (`src/app/app-chrome.tsx`, `src/app/s/…`).
 */
export function SiteChrome({ homeHref, actions, banner, children }: SiteChromeProps) {
  const wordmark = (
    <>
      <BrandMark />
      git-moxfield
    </>
  );
  return (
    <>
      {/* Above the page's own positioned elements, so the account menu's panel overlaps them. */}
      <header className="relative z-40 border-b border-border bg-surface/85 pt-[env(safe-area-inset-top)] backdrop-blur-md">
        <div className="page-gutter mx-auto flex h-14 w-full max-w-page items-center justify-between gap-4">
          {homeHref === undefined ? (
            <span className={WORDMARK}>{wordmark}</span>
          ) : (
            <Link href={homeHref} className={WORDMARK}>
              {wordmark}
            </Link>
          )}
          {actions}
        </div>
        {banner}
      </header>
      <main id="main" className="page-gutter mx-auto w-full max-w-page flex-1 pt-6 pb-10 md:pt-8 md:pb-16">
        {children}
      </main>
      <footer className="border-t border-border">
        <div className="page-gutter mx-auto flex w-full max-w-page flex-wrap items-center justify-between gap-x-4 gap-y-1 py-5 text-xs text-subtle">
          <p>
            git-moxfield <span className="tabular">v{packageJson.version}</span>
          </p>
          <p>Not affiliated with Moxfield. Nothing is ever written to your Moxfield decks.</p>
        </div>
      </footer>
    </>
  );
}
