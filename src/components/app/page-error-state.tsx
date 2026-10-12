'use client';

import clsx from 'clsx';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * The body of an error boundary (`error.tsx`): logs the error to the console and shows a
 * calm message with its reference (`digest`), Try again (`retry`) and another way out.
 */
export function PageErrorState({
  error,
  retry,
  description,
  secondaryAction,
  className,
}: {
  error: Error & { digest?: string };
  retry: () => void;
  /** Followed by the error's reference. */
  description: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <EmptyState
      className={clsx('mx-auto max-w-xl', className)}
      headingLevel={1}
      icon={<TriangleAlert aria-hidden="true" />}
      title="Something went wrong"
      description={
        <>
          {description}
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
          {secondaryAction}
        </>
      }
    />
  );
}
