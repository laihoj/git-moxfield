import type { Metadata } from 'next';

import { CaptureClient } from '@/components/capture/capture-client';
import { getServices } from '@/server/services';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Send to git-moxfield',
  // The capture page is a hand-over endpoint, not content.
  robots: { index: false, follow: false },
};

const FORM_ERRORS: ReadonlySet<string> = new Set(['invalid', 'too-large', 'failed']);

/**
 * Bookmarklet landing page (`#n=<nonce>`, opened by the bookmarklet on Moxfield) and the
 * manual paste fallback (`?mode=paste`).
 */
export default async function CapturePage({ searchParams }: PageProps<'/capture'>) {
  const { mode, error } = await searchParams;
  const setup = getServices().getSetupInfo();
  const formError = typeof error === 'string' && FORM_ERRORS.has(error) ? error : null;
  return (
    <CaptureClient
      allowedOrigins={setup.captureAllowedOrigins}
      apiBaseUrl={setup.moxfieldApiBaseUrl}
      siteOrigin={setup.moxfieldSiteOrigin}
      initialMode={mode === 'paste' || formError !== null ? 'paste' : 'auto'}
      formError={formError}
    />
  );
}
