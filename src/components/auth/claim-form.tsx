'use client';

import { useActionState, useId } from 'react';

import type { SignInFormState } from '@/app/action-types';
import { claimAction } from '@/app/auth-actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import { Field, fieldDescriptionIds, Input } from '@/components/ui/field';

export interface ClaimFormProps {
  /** Longest display name the server accepts. */
  maxNameLength: number;
}

/**
 * First-run claim: the setup code from the server log and the first admin's name. On
 * success the server action signs this browser in and continues to creating a bookmarklet.
 */
export function ClaimForm({ maxNameLength }: ClaimFormProps) {
  const codeId = useId();
  const nameId = useId();
  const [state, action, pending] = useActionState<SignInFormState, FormData>(claimAction, { status: 'idle' });
  const error = state.status === 'error' ? state : null;
  const codeError = error?.field === 'code' ? error.message : undefined;
  const nameError = error?.field === 'name' ? error.message : undefined;
  // Remount the inputs with what was typed: React resets a form after its action.
  const attempt = error === null ? 'idle' : `${error.values?.code ?? ''}\u0000${error.values?.name ?? ''}`;

  return (
    <form action={action} className="flex flex-col gap-5">
      <Field
        label="Setup code"
        htmlFor={codeId}
        hint="Printed in the server log when git-moxfield starts."
        error={codeError}
      >
        <Input
          key={`code:${attempt}`}
          id={codeId}
          name="code"
          required
          maxLength={64}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          placeholder="XXXX-XXXX-XXXX"
          defaultValue={error?.values?.code ?? ''}
          aria-invalid={codeError !== undefined || undefined}
          aria-describedby={fieldDescriptionIds(codeId)[codeError === undefined ? 'hint' : 'error']}
          className="font-mono tracking-wider uppercase placeholder:tracking-wider"
        />
      </Field>
      <Field
        label="Your name"
        htmlFor={nameId}
        hint="Shown to the people you invite. You can change it later."
        error={nameError}
      >
        <Input
          key={`name:${attempt}`}
          id={nameId}
          name="name"
          required
          maxLength={maxNameLength}
          autoComplete="nickname"
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
        Become the admin
      </Button>
      <Disclosure summary="Where do I find the setup code?" className="-mt-1">
        <p className="text-sm text-pretty text-muted">
          git-moxfield writes it to its log every time it starts, in a line that says “enter the setup code”.
          On the computer that runs git-moxfield, you can also print it with{' '}
          <code className="rounded bg-surface-2 px-1 py-0.5 text-[0.8125rem] whitespace-nowrap text-fg">
            pnpm users claim-code
          </code>
          .
        </p>
      </Disclosure>
    </form>
  );
}
