'use client';

import { LogOut } from 'lucide-react';
import { useFormStatus } from 'react-dom';

import { signOutEverywhereAction } from '@/app/account-actions';
import { signOutAction } from '@/app/auth-actions';
import { Button } from '@/components/ui/button';
import { InlineConfirm } from '@/components/ui/inline-confirm';

/** Sign out of this browser, or of every signed-in browser at once. */
export function SignOutPanel() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={signOutAction}>
        <SignOutButton />
      </form>
      <InlineConfirm
        trigger={{ label: 'Sign out everywhere', variant: 'ghost' }}
        message="Sign out on every device, this one included? Each needs your bookmarklet or a device link to sign in again."
        confirmLabel="Sign out everywhere"
        onConfirm={async () => {
          const result = await signOutEverywhereAction();
          return result.ok ? null : result.message;
        }}
      />
    </div>
  );
}

function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="secondary"
      loading={pending}
      icon={<LogOut aria-hidden="true" className="size-4" />}
    >
      Sign out
    </Button>
  );
}
