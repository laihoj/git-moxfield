'use client';

import { RotateCcw, TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

/** Error boundary of the share link pages: a calm message and a retry (there is no app to go back to). */
export default function SharedPageError({
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
      className="mx-auto mt-2 max-w-xl"
      headingLevel={1}
      icon={<TriangleAlert aria-hidden="true" />}
      title="Something went wrong"
      description={
        <>
          This page could not be loaded. Try again in a moment.
          {error.digest !== undefined && (
            <span className="mt-2 block font-mono text-xs text-subtle">Reference: {error.digest}</span>
          )}
        </>
      }
      actions={
        <Button variant="primary" icon={<RotateCcw aria-hidden="true" className="size-4" />} onClick={retry}>
          Try again
        </Button>
      }
    />
  );
}
