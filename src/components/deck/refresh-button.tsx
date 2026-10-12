'use client';

import { RefreshCw } from 'lucide-react';
import { useTransition } from 'react';

import { refreshAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toaster';

export interface RefreshButtonProps {
  deckId: string;
  /** Label for the button; defaults to `Refresh`. */
  label?: string;
  variant?: 'secondary' | 'primary';
}

/**
 * Fetches the current Moxfield deck on the server. The page re-renders with the new
 * state in the same round trip; the outcome is confirmed with a toast (failures are
 * also shown in the status panel, which records the last fetch error).
 */
export function RefreshButton({ deckId, label = 'Refresh', variant = 'secondary' }: RefreshButtonProps) {
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  function refresh(): void {
    startTransition(async () => {
      const result = await refreshAction(deckId);
      if (result.ok) {
        toast(
          result.changed
            ? { title: 'Updated from Moxfield', description: 'Review the new changes below.' }
            : { title: 'No new changes on Moxfield', tone: 'info' },
        );
      } else if (result.code === 'rate-limited') {
        toast({ title: 'Checked moments ago', description: result.message, tone: 'info' });
      } else {
        toast({ title: 'Could not refresh', description: result.message, tone: 'error' });
      }
    });
  }

  return (
    <Button
      variant={variant}
      size="sm"
      loading={pending}
      icon={<RefreshCw aria-hidden="true" className="size-4" />}
      className="max-sm:size-11 max-sm:px-0"
      title={label}
      onClick={refresh}
    >
      <span className="max-sm:sr-only">{pending ? 'Checking…' : label}</span>
    </Button>
  );
}
