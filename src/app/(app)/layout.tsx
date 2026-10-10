import type { ReactNode } from 'react';

import { AppChrome } from '@/app/app-chrome';

/**
 * Every page of the app (everything but the share link pages under `/s`): the header
 * with navigation and the account menu when signed in, only the wordmark when signed
 * out.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppChrome>{children}</AppChrome>;
}
