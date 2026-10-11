import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';

import { NavigationProgress } from '@/components/ui/navigation';
import { Toaster } from '@/components/ui/toaster';
import { APP_DESCRIPTION, APP_NAME, THEME } from '@/lib/brand';

import './globals.css';

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: APP_DESCRIPTION,
  applicationName: APP_NAME,
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: 'default' },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: THEME.light.bg },
    { media: '(prefers-color-scheme: dark)', color: THEME.dark.bg },
  ],
};

/**
 * The document of every page. The page frame (header, main content, footer) belongs to
 * the two kinds of pages below it: the app (`(app)/layout.tsx`, which looks up who is
 * signed in) and the read-only share link pages (`s/[token]/layout.tsx`, which never do).
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page depends on the request (a session, a share link). Stop prerendering here,
  // before anything opens the database: a build must never open, migrate or write to it.
  await connection();
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only z-50 rounded-lg bg-surface px-3 py-2 text-sm font-medium shadow-pop focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
          Skip to content
        </a>
        <NavigationProgress />
        <Toaster>{children}</Toaster>
      </body>
    </html>
  );
}
