'use client';

import { Trash2 } from 'lucide-react';
import { useState, useTransition } from 'react';

import { untrackDeckAction } from '@/app/actions';
import { Button } from '@/components/ui/button';

export interface UntrackDeckButtonProps {
  deckId: string;
  deckName: string;
  versionCount: number;
}

/**
 * Stops tracking a deck after an explicit confirmation step. Deletes the deck's
 * history from git-moxfield only; the deck on Moxfield is never touched.
 */
export function UntrackDeckButton({ deckId, deckName, versionCount }: UntrackDeckButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!confirming) {
    return (
      <Button
        variant="ghost"
        size="sm"
        icon={<Trash2 aria-hidden="true" className="size-4" />}
        onClick={() => {
          setConfirming(true);
        }}
      >
        Stop tracking
      </Button>
    );
  }

  return (
    <div
      role="group"
      aria-label="Confirm stop tracking"
      className="flex flex-col gap-3 rounded-xl border border-remove/30 bg-remove-bg p-4"
    >
      <p className="text-sm text-fg">
        Stop tracking <span className="font-semibold">{deckName}</span>? This deletes{' '}
        {versionCount === 0 ? 'its snapshots' : `all ${versionCount} versions, tags and notes`} from
        git-moxfield. The deck on Moxfield is not affected.
      </p>
      {error !== null && (
        <p role="alert" className="text-sm text-remove">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="danger"
          size="sm"
          loading={pending}
          onClick={() => {
            startTransition(async () => {
              const result = await untrackDeckAction(deckId);
              setError(result.message);
            });
          }}
        >
          Stop tracking and delete history
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
