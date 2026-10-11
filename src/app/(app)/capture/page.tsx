import type { Metadata } from 'next';

import { CaptureClient } from '@/components/capture/capture-client';
import { CAPTURE_PASTE_MODE, parseCaptureFormError } from '@/integrations/moxfield/capture-protocol';
import { routes } from '@/lib/routes';
import { getSetupInfo } from '@/server/access';
import { getCurrentUser, requireUser } from '@/server/auth/current-user';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Send to git-moxfield',
  // The capture page is a hand-over endpoint, not content.
  robots: { index: false, follow: false },
};

/**
 * Bookmarklet landing page (`#n=<nonce>`, opened by the bookmarklet on Moxfield) and the
 * manual paste fallback (`?mode=paste`).
 */
export default async function CapturePage({ searchParams }: PageProps<'/capture'>) {
  const { mode, error } = await searchParams;
  const formError = parseCaptureFormError(error);
  // Manual paste needs a signed-in browser. The bookmarklet hand-over does not: its
  // PAYLOAD carries the bookmarklet key, which signs the browser in.
  const user =
    mode === CAPTURE_PASTE_MODE || formError !== null
      ? await requireUser({ next: routes.capturePaste() })
      : await getCurrentUser();
  const setup = getSetupInfo();
  return (
    <CaptureClient
      allowedOrigins={setup.captureAllowedOrigins}
      apiBaseUrl={setup.moxfieldApiBaseUrl}
      siteOrigin={setup.moxfieldSiteOrigin}
      initialMode={mode === CAPTURE_PASTE_MODE || formError !== null ? 'paste' : 'auto'}
      formError={formError}
      signedIn={user !== null}
    />
  );
}
