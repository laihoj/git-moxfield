'use client';

import { useActionState, useId } from 'react';

import type { SignInFormState } from '@/app/action-types';
import { acceptInviteAction } from '@/app/auth-actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, fieldDescriptionIds, Input } from '@/components/ui/field';

export interface InviteFormProps {
  /** The invite token from the link (also in the page's URL). */
  token: string;
  /** Longest display name the server accepts. */
  maxNameLength: number;
}

/**
 * Accepting an invite: the new user picks a display name. On success the server action
 * creates the account, signs this browser in and continues to creating a bookmarklet.
 */
export function InviteForm({ token, maxNameLength }: InviteFormProps) {
  const nameId = useId();
  const [state, action, pending] = useActionState<SignInFormState, FormData>(acceptInviteAction, {
    status: 'idle',
  });
  const error = state.status === 'error' ? state : null;
  const nameError = error?.field === 'name' ? error.message : undefined;

  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="token" value={token} />
      <Field
        label="Your name"
        htmlFor={nameId}
        hint="How you appear in git-moxfield. You can change it later."
        error={nameError}
      >
        <Input
          key={error === null ? 'idle' : `name:${error.values?.name ?? ''}`}
          id={nameId}
          name="name"
          required
          maxLength={maxNameLength}
          autoComplete="nickname"
          autoFocus
          defaultValue={error?.values?.name ?? ''}
          aria-invalid={nameError !== undefined || undefined}
          aria-describedby={fieldDescriptionIds(nameId)[nameError === undefined ? 'hint' : 'error']}
        />
      </Field>
      {error !== null && error.field === undefined && (
        <Alert tone="error" role="alert">
          {error.message}
        </Alert>
      )}
      <Button type="submit" variant="primary" size="lg" block loading={pending}>
        Create my account
      </Button>
    </form>
  );
}
