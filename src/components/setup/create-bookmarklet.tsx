'use client';

import { CircleCheck, KeyRound, Plus } from 'lucide-react';
import { useActionState, useId, useState } from 'react';

import type { CreateBookmarkletState } from '@/app/action-types';
import { createBookmarkletAction } from '@/app/account-actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { fieldDescriptionIds, Input } from '@/components/ui/field';

import { BookmarkletInstall } from './bookmarklet-install';

export interface CreateBookmarkletProps {
  /** Suggested name, from the browser this page was opened in (`Chrome on Mac`). */
  defaultLabel: string;
  maxLabelLength: number;
  /** Moxfield's host, e.g. `moxfield.com`. */
  siteHost: string;
  /** git-moxfield's public base URL the bookmarklets send decks to. */
  appUrl: string;
  /** Focus the name field (onboarding, where creating a bookmarklet is the next step). */
  autoFocus?: boolean;
}

/**
 * "Create a bookmarklet": name it, create it, install it. The new bookmarklets carry a
 * personal key, so they are shown exactly once, from this component's state: they are
 * gone after "I've installed it" or when the page is left, and can never be shown again
 * (a new one can always be made).
 */
export function CreateBookmarklet({
  defaultLabel,
  maxLabelLength,
  siteHost,
  appUrl,
  autoFocus = false,
}: CreateBookmarkletProps) {
  const labelId = useId();
  const ids = fieldDescriptionIds(labelId);
  const [state, action, pending] = useActionState<CreateBookmarkletState, FormData>(createBookmarkletAction, {
    status: 'idle',
  });
  /** The created bookmarklet the user has put away ("I've installed it"). */
  const [installedId, setInstalledId] = useState<string | null>(null);

  if (state.status === 'created' && state.id !== installedId) {
    return (
      <section aria-labelledby="new-bookmarklet-heading" className="flex flex-col gap-4">
        <h3 id="new-bookmarklet-heading" className="flex items-center gap-2 text-base font-semibold text-fg">
          <CircleCheck aria-hidden="true" className="size-5 shrink-0 text-add" />
          <span className="min-w-0 break-words">“{state.label}” is ready. Install it now.</span>
        </h3>
        <Alert tone="warn" title="This is the only time it’s shown">
          The bookmarklet is your personal key: whoever has it can sign in as you, so don’t share it. Once you
          leave this page it can’t be shown again; you can always make a new one.
        </Alert>
        <BookmarkletInstall popup={state.popup} sameTab={state.sameTab} siteHost={siteHost} appUrl={appUrl} />
        <div>
          <Button
            variant="secondary"
            onClick={() => {
              setInstalledId(state.id);
            }}
          >
            I’ve installed it
          </Button>
        </div>
      </section>
    );
  }

  const error = state.status === 'error' ? state : null;
  const installed = state.status === 'created' ? state : null;

  return (
    <form action={action} className="flex flex-col gap-3">
      {installed !== null && (
        <Alert tone="success" role="status" title={`“${installed.label}” is installed`}>
          Run it on one of your decks on {siteHost} to send the deck here.
        </Alert>
      )}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={labelId} className="text-sm font-medium text-fg">
          {installed === null ? 'Name your bookmarklet' : 'Make another bookmarklet'}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            key={error === null ? `idle:${installed?.id ?? ''}` : `error:${error.label}`}
            id={labelId}
            name="label"
            required
            maxLength={maxLabelLength}
            autoComplete="off"
            autoFocus={autoFocus}
            defaultValue={error?.label ?? defaultLabel}
            aria-invalid={error !== null || undefined}
            aria-describedby={error === null ? ids.hint : ids.error}
            className="sm:flex-1"
          />
          <Button
            type="submit"
            variant="primary"
            loading={pending}
            icon={
              installed === null ? (
                <KeyRound aria-hidden="true" className="size-4" />
              ) : (
                <Plus aria-hidden="true" className="size-4" />
              )
            }
          >
            Create bookmarklet
          </Button>
        </div>
        {error === null ? (
          <p id={ids.hint} className="text-xs text-muted">
            Tells your bookmarklets apart in Account, e.g. the browser it lives in.
          </p>
        ) : (
          <p id={ids.error} role="alert" className="text-sm text-remove">
            {error.message}
          </p>
        )}
      </div>
    </form>
  );
}
