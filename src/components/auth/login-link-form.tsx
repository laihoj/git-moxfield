'use client';

import { LogIn } from 'lucide-react';
import { useActionState } from 'react';

import type { SignInFormState } from '@/app/action-types';
import { signInWithLinkAction } from '@/app/auth-actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/**
 * The one button of a device or recovery link page. The link is only used up by this
 * POST, never by opening the page, so link previews in chat apps cannot consume it.
 */
export function LoginLinkForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<SignInFormState, FormData>(signInWithLinkAction, {
    status: 'idle',
  });
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      {state.status === 'error' && (
        <Alert tone="error" role="alert">
          {state.message}
        </Alert>
      )}
      <Button
        type="submit"
        variant="primary"
        size="lg"
        block
        loading={pending}
        icon={<LogIn aria-hidden="true" className="size-5" />}
      >
        Sign in on this device
      </Button>
    </form>
  );
}
