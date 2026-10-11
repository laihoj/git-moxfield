'use client';

import { PageErrorState } from '@/components/app/page-error-state';
import { ButtonLink } from '@/components/ui/button';
import { routes } from '@/lib/routes';

/** Error boundary for every page: a calm message, a retry, and a way home. */
export default function ErrorPage({
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
      className="mt-6"
      description="This page could not be loaded. Your versions are safe; try again in a moment."
      secondaryAction={
        <ButtonLink href={routes.home()} variant="secondary">
          Your decks
        </ButtonLink>
      }
    />
  );
}
