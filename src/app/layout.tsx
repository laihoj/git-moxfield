import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { BrandMark } from '@/components/app/brand-mark';
import { MainNav } from '@/components/app/main-nav';
import { Toaster } from '@/components/ui/toaster';

import packageJson from '../../package.json';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'git-moxfield', template: '%s · git-moxfield' },
  description: 'Version control, semantic diffs and history for Moxfield decks.',
  applicationName: 'git-moxfield',
  appleWebApp: { capable: true, title: 'git-moxfield', statusBarStyle: 'default' },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f6f8' },
    { media: '(prefers-color-scheme: dark)', color: '#0d0e12' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only z-50 rounded-lg bg-surface px-3 py-2 text-sm font-medium shadow-pop focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
          Skip to content
        </a>
        <Toaster>
          <header className="border-b border-border bg-surface/85 pt-[env(safe-area-inset-top)] backdrop-blur-md">
            <div className="page-gutter mx-auto flex h-14 w-full max-w-[1080px] items-center justify-between gap-4">
              <Link
                href="/"
                className="-ml-1 flex items-center gap-2 rounded-lg p-1 text-[0.9375rem] font-semibold tracking-tight text-fg"
              >
                <BrandMark />
                git-moxfield
              </Link>
              <MainNav />
            </div>
          </header>
          <main
            id="main"
            className="page-gutter mx-auto w-full max-w-[1080px] flex-1 pt-6 pb-10 md:pt-8 md:pb-16"
          >
            {children}
          </main>
          <footer className="border-t border-border">
            <div className="page-gutter mx-auto flex w-full max-w-[1080px] flex-wrap items-center justify-between gap-x-4 gap-y-1 py-5 text-xs text-subtle">
              <p>
                git-moxfield <span className="tabular">v{packageJson.version}</span>
              </p>
              <p>Not affiliated with Moxfield. Nothing is ever written to your Moxfield decks.</p>
            </div>
          </footer>
        </Toaster>
      </body>
    </html>
  );
}
