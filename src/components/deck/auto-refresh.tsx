'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { refreshAction } from '@/app/actions';
import { Spinner } from '@/components/ui/spinner';

export interface AutoRefreshProps {
  deckId: string;
  /** `DeckOverviewDTO.autoRefreshSuggested`: the last check is old enough to look again. */
  enabled: boolean;
}

/**
 * Background refresh after the deck page has rendered (docs/architecture.md, fetch
 * policy): once per mount, only when the server suggests it. The page is shown
 * immediately with the last known state; when the fetch completes the route is
 * refreshed so the status, diff and "checked" time update in place.
 */
export function AutoRefresh({ deckId, enabled }: AutoRefreshProps) {
  const router = useRouter();
  const [checking, setChecking] = useState(enabled);
  /** Guards against React Strict Mode's double effect invocation in development. */
  const started = useRef(false);

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    void refreshAction(deckId, 'auto')
      .catch(() => {
        // Failures are recorded on the deck and shown by the status panel after the refresh.
      })
      .finally(() => {
        setChecking(false);
        router.refresh();
      });
  }, [deckId, enabled, router]);

  if (!checking) return null;
  return (
    <p role="status" className="flex items-center gap-1.5 text-xs text-muted">
      <Spinner className="size-3.5" />
      Checking Moxfield for changes…
    </p>
  );
}
