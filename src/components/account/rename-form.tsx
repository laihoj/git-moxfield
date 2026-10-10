'use client';

import { Check } from 'lucide-react';
import { useActionState, useId } from 'react';

import type { RenameState } from '@/app/action-types';
import { renameSelfAction } from '@/app/account-actions';
import { Button } from '@/components/ui/button';
import { fieldDescriptionIds, Input } from '@/components/ui/field';

export interface RenameFormProps {
  displayName: string;
  maxLength: number;
}

/** The signed-in user's display name, editable in place. */
export function RenameForm({ displayName, maxLength }: RenameFormProps) {
  const id = useId();
  const ids = fieldDescriptionIds(id);
  const [state, action, pending] = useActionState<RenameState, FormData>(renameSelfAction, {
    status: 'idle',
  });
  const error = state.status === 'error' ? state : null;
  const current = state.status === 'saved' ? state.displayName : displayName;

  return (
    <form action={action} className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        Display name
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          key={error === null ? `saved:${current}` : `error:${error.value}`}
          id={id}
          name="name"
          required
          maxLength={maxLength}
          autoComplete="nickname"
          defaultValue={error?.value ?? current}
          aria-invalid={error !== null || undefined}
          aria-describedby={error === null ? ids.hint : ids.error}
          className="sm:flex-1"
        />
        <Button type="submit" variant="secondary" loading={pending}>
          Save name
        </Button>
      </div>
      {error === null ? (
        <p id={ids.hint} role="status" className="flex items-center gap-1.5 text-xs text-muted">
          {state.status === 'saved' ? (
            <>
              <Check aria-hidden="true" className="size-3.5 text-add" />
              Saved.
            </>
          ) : (
            'Shown in the header, on your share links, and to admins when they manage accounts.'
          )}
        </p>
      ) : (
        <p id={ids.error} role="alert" className="text-sm text-remove">
          {error.message}
        </p>
      )}
    </form>
  );
}
