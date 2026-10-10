'use client';

import { Plus } from 'lucide-react';
import { useActionState, useId } from 'react';

import type { TrackDeckState } from '@/app/action-types';
import { trackDeckAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { fieldDescriptionIds, Input } from '@/components/ui/field';

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
  const ids = fieldDescriptionIds(id);
  const [state, formAction, pending] = useActionState<TrackDeckState, FormData>(trackDeckAction, {
    status: 'idle',
  });
  const error = state.status === 'error' ? state.message : null;

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        Moxfield deck URL
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={id}
          name="deck"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus={autoFocus}
          required
          defaultValue={state.status === 'error' ? state.input : ''}
          key={state.status === 'error' ? `error:${state.input}` : 'idle'}
          placeholder="https://moxfield.com/decks/…"
          aria-invalid={error !== null || undefined}
          aria-describedby={error !== null ? ids.error : hint ? ids.hint : undefined}
          className="sm:flex-1"
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
      {error !== null ? (
        <p id={ids.error} role="alert" className="text-sm text-remove">
          {error}
        </p>
      ) : (
        hint && (
          <p id={ids.hint} className="text-xs text-muted">
            Public and unlisted decks work. Nothing is ever written to Moxfield.
          </p>
        )
      )}
    </form>
  );
}
