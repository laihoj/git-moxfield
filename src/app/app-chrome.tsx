import { connection } from 'next/server';
import type { ReactNode } from 'react';

import { MainNav } from '@/components/app/main-nav';
import { SiteChrome } from '@/components/app/site-chrome';
import { UserMenu } from '@/components/app/user-menu';
import { routes } from '@/lib/routes';
import { getCurrentUser } from '@/server/auth/current-user';

/**
 * The app's page frame: the wordmark (to the decks page), and for a signed-in user the
 * main navigation and the account menu. Used by the `(app)` layout and the root
 * not-found page. Share link pages have a frame of their own and never look for a
 * session (`src/app/s/`).
 */
export async function AppChrome({ children }: { children: ReactNode }) {
  // Layouts render in parallel with what they wrap, so the root layout's `connection()`
  // does not hold this back: stop prerendering here too, before the session lookup opens
  // the database (a build must never open, migrate or write to it).
  await connection();
  const user = await getCurrentUser();
  return (
    <SiteChrome
      homeHref={routes.home()}
      actions={
        user === null ? undefined : (
          <div className="flex items-center gap-1 sm:gap-2">
            <MainNav />
            <UserMenu displayName={user.displayName} isAdmin={user.role === 'admin'} />
          </div>
        )
      }
    >
      {children}
    </SiteChrome>
  );
}
