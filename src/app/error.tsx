'use client';

import { RotateCcw, TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';

import { Button, ButtonLink } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

/** Error boundary for every page: a calm message, a retry, and a way home. */
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <EmptyState
      className="mx-auto mt-6 max-w-xl"
      icon={<TriangleAlert aria-hidden="true" />}
      title="Something went wrong"
      description={
        <>
          This page could not be loaded. Your versions are safe; try again in a moment.
          {error.digest !== undefined && (
            <span className="mt-2 block font-mono text-xs text-subtle">Reference: {error.digest}</span>
          )}
        </>
      }
      actions={
        <>
          <Button
            variant="primary"
            icon={<RotateCcw aria-hidden="true" className="size-4" />}
            onClick={retry}
          >
            Try again
          </Button>
          <ButtonLink href="/" variant="secondary">
            Your decks
          </ButtonLink>
        </>
      }
    />
  );
}
