'use client';

import { Check } from 'lucide-react';
import { useActionState, useId } from 'react';

import type { RenameState } from '@/app/action-types';
import { renameSelfAction } from '@/app/account-actions';
import { DisplayNameInput } from '@/components/account/display-name-input';
import { Button } from '@/components/ui/button';
import { Field, fieldControlProps } from '@/components/ui/field';

/** The signed-in user's display name, editable in place. */
export function RenameForm({ displayName }: { displayName: string }) {
  const id = useId();
  const [state, action, pending] = useActionState<RenameState, FormData>(renameSelfAction, {
    status: 'idle',
  });
  const error = state.status === 'error' ? state : null;
  const current = state.status === 'saved' ? state.displayName : displayName;

  return (
    <form action={action}>
      <Field
        label="Display name"
        htmlFor={id}
        hintRole="status"
        hint={
          state.status === 'saved' ? (
            <span className="flex items-center gap-1.5">
              <Check aria-hidden="true" className="size-3.5 text-add" />
              Saved.
            </span>
          ) : (
            'Shown in the header, on your share links, and to admins when they manage accounts.'
          )
        }
        error={error?.message}
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <DisplayNameInput
            key={error === null ? `saved:${current}` : `error:${error.value}`}
            defaultValue={error?.value ?? current}
            className="sm:flex-1"
            {...fieldControlProps(id, { invalid: error !== null })}
          />
          <Button type="submit" variant="secondary" loading={pending}>
            Save name
          </Button>
        </div>
      </Field>
    </form>
  );
}
