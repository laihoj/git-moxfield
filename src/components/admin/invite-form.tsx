'use client';

import clsx from 'clsx';
import { Send } from 'lucide-react';
import { useActionState, useId, type ReactNode } from 'react';

import type { CreateInviteState } from '@/app/action-types';
import { createInviteAction } from '@/app/admin-actions';
import { OneTimeLink } from '@/components/account/one-time-link';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, fieldDescriptionIds, Input } from '@/components/ui/field';

export interface InviteFormProps {
  maxNoteLength: number;
}

/**
 * "Invite someone": an optional note (a reminder for admins) and the role. The new
 * invite's link is shown above the form, once; the admin sends it to the person.
 */
export function InviteForm({ maxNoteLength }: InviteFormProps) {
  const noteId = useId();
  const ids = fieldDescriptionIds(noteId);
  const [state, action, pending] = useActionState<CreateInviteState, FormData>(createInviteAction, {
    status: 'idle',
  });
  const error = state.status === 'error' ? state : null;
  const role = error?.values.role === 'admin' ? 'admin' : 'member';

  return (
    <div className="flex flex-col gap-5">
      {state.status === 'created' && (
        <section
          aria-label="New invite link"
          className="rounded-lg border border-add/25 bg-add-bg p-4"
          role="status"
        >
          <OneTimeLink url={state.url} expiresAt={state.expiresAt} subject="Invite link" meta="works once">
            <p className="font-semibold">Invite link ready</p>
            <p className="mt-0.5 text-fg/85">
              Send it to{' '}
              {state.note === '' ? (
                'the person you’re inviting'
              ) : (
                <span className="font-medium">{state.note}</span>
              )}
              . It makes one {state.role === 'admin' ? 'admin' : 'member'} account. This is the only time the
              link is shown.
            </p>
          </OneTimeLink>
        </section>
      )}

      <form action={action} className="flex flex-col gap-5">
        <Field
          label="Who is it for?"
          htmlFor={noteId}
          hint="Optional. A reminder for admins; the person you invite doesn’t see it."
        >
          <Input
            key={
              error === null
                ? `idle:${state.status === 'created' ? state.url : ''}`
                : `error:${error.values.note}`
            }
            id={noteId}
            name="note"
            maxLength={maxNoteLength}
            autoComplete="off"
            placeholder="e.g. Mikko from the Tuesday pod"
            defaultValue={error?.values.note ?? ''}
            aria-describedby={ids.hint}
          />
        </Field>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-fg">Role</legend>
          <div key={error === null ? 'idle' : `error:${role}`} className="grid gap-2 sm:grid-cols-2">
            <RoleOption value="member" defaultChecked={role === 'member'} title="Member">
              Their own private decks and history.
            </RoleOption>
            <RoleOption value="admin" defaultChecked={role === 'admin'} title="Admin">
              Can also invite people and help them back in. Manages accounts, not decks.
            </RoleOption>
          </div>
        </fieldset>

        {error !== null && (
          <Alert tone="error" role="alert">
            {error.message}
          </Alert>
        )}

        <div>
          <Button
            type="submit"
            variant="primary"
            loading={pending}
            icon={<Send aria-hidden="true" className="size-4" />}
          >
            Create invite link
          </Button>
        </div>
      </form>
    </div>
  );
}

function RoleOption({
  value,
  defaultChecked,
  title,
  children,
}: {
  value: 'member' | 'admin';
  defaultChecked: boolean;
  title: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={clsx(
        'flex cursor-pointer gap-3 rounded-lg border border-border-strong bg-surface p-3 transition-colors hover:bg-surface-2',
        'has-[:checked]:border-accent has-[:checked]:bg-accent-soft/50 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
      )}
    >
      <input
        id={id}
        type="radio"
        name="role"
        value={value}
        defaultChecked={defaultChecked}
        className="mt-0.5 size-4 shrink-0 accent-[var(--accent)] focus-visible:outline-none"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-fg">{title}</span>
        <span className="block text-xs text-pretty text-muted">{children}</span>
      </span>
    </label>
  );
}
