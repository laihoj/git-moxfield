import { ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { after } from 'next/server';

import { AuthPanel } from '@/components/auth/auth-panel';
import { ClaimForm } from '@/components/auth/claim-form';
import { Card } from '@/components/ui/card';
import { routes } from '@/lib/routes';
import { getAuthService, MAX_DISPLAY_NAME_LENGTH } from '@/server/auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Set up git-moxfield', robots: { index: false, follow: false } };

/**
 * First run (ADR 0006): while git-moxfield has no users, whoever has the setup code from
 * the server log becomes its first admin here. Once anyone exists, this page only sends
 * visitors to sign in.
 *
 * Opening it makes sure a setup code exists and prints it to the server log again
 * (`claimStatus`), but only after the response is sent: in development, React replays
 * console output from rendering into the visitor's browser console, which would hand the
 * code to whoever opens this page.
 */
export default async function ClaimPage() {
  const auth = await getAuthService();
  if (!(await auth.isClaimable())) redirect(routes.signIn());
  after(async () => {
    await auth.claimStatus();
  });

  return (
    <AuthPanel
      icon={<ShieldCheck aria-hidden="true" />}
      title="Set up git-moxfield"
      description={
        <>
          You’re the first one here. Enter the setup code from the server log to become this{' '}
          <span className="whitespace-nowrap">git-moxfield’s</span> admin.
        </>
      }
      footer="As the admin you invite friends and help them back in. Admins manage accounts, not decks."
    >
      <Card>
        <ClaimForm maxNameLength={MAX_DISPLAY_NAME_LENGTH} />
      </Card>
    </AuthPanel>
  );
}
