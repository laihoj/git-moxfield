'use client';

import { PageErrorState } from '@/components/app/page-error-state';

/** Error boundary of the share link pages: a calm message and a retry (there is no app to go back to). */
export default function SharedPageError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <PageErrorState
      error={error}
      retry={retry}
      className="mt-2"
      description="This page could not be loaded. Try again in a moment."
    />
  );
}
