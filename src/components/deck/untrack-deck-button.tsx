'use client';

import { Trash2 } from 'lucide-react';

import { untrackDeckAction } from '@/app/actions';
import { InlineConfirm } from '@/components/ui/inline-confirm';

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
  return (
    <InlineConfirm
      trigger={{ label: 'Stop tracking', icon: <Trash2 aria-hidden="true" className="size-4" /> }}
      message={
        <>
          Stop tracking <span className="font-semibold">{deckName}</span>? This deletes{' '}
          {versionCount === 0 ? 'its snapshots' : `all ${versionCount} versions, tags and notes`} from
          git-moxfield. The deck on Moxfield is not affected.
        </>
      }
      confirmLabel="Stop tracking and delete history"
      // Success redirects to the deck list, so only a failure ever returns.
      onConfirm={() => untrackDeckAction(deckId)}
    />
  );
}
