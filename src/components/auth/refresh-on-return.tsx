'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Refreshes at most this often, however often the tab is switched. */
const MIN_INTERVAL_MS = 2_000;

/**
 * Re-renders the page from the server whenever its tab becomes visible again. On the
 * sign-in page this notices a sign-in that happened elsewhere in the same browser (the
 * bookmarklet run in a Moxfield tab, a device link opened in another tab): the page then
 * redirects to where the user was going. Renders nothing.
 */
export function RefreshOnReturn() {
  const router = useRouter();
  useEffect(() => {
    let last = 0;
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible' || Date.now() - last < MIN_INTERVAL_MS) return;
      last = Date.now();
      router.refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [router]);
  return null;
}
