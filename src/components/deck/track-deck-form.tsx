'use client';

import { Plus } from 'lucide-react';
import { useActionState, useId } from 'react';

import type { TrackDeckState } from '@/app/action-types';
import { trackDeckAction } from '@/app/actions';
import { DeckUrlInput } from '@/components/deck/deck-url-input';
import { Button } from '@/components/ui/button';
import { Field, fieldControlProps } from '@/components/ui/field';

export interface TrackDeckFormProps {
  autoFocus?: boolean;
  /** Show the "Public and unlisted decks work" hint (hide it when the surrounding text says it). */
  hint?: boolean;
}

/**
 * "Track a Moxfield deck": paste a deck URL (or id). On success the server action
 * redirects to the new deck's page; validation errors are shown inline.
 */
export function TrackDeckForm({ autoFocus = false, hint = true }: TrackDeckFormProps) {
  const id = useId();
  const [state, formAction, pending] = useActionState<TrackDeckState, FormData>(trackDeckAction, {
    status: 'idle',
  });
  const error = state.status === 'error' ? state : null;

  return (
    <form action={formAction}>
      <Field
        label="Moxfield deck URL"
        htmlFor={id}
        hint={hint ? 'Public and unlisted decks work. Nothing is ever written to Moxfield.' : undefined}
        error={error?.message}
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <DeckUrlInput
            name="deck"
            autoFocus={autoFocus}
            required
            defaultValue={error?.input ?? ''}
            key={error === null ? 'idle' : `error:${error.input}`}
            className="sm:flex-1"
            {...fieldControlProps(id, { invalid: error !== null, hint })}
          />
          <Button
            type="submit"
            variant="primary"
            loading={pending}
            icon={<Plus aria-hidden="true" className="size-4" />}
          >
            Track deck
          </Button>
        </div>
      </Field>
    </form>
  );
}
