'use client';

import clsx from 'clsx';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

export interface PageErrorStateProps {
  error: Error & { digest?: string };
  /** Renders the page again (the boundary's `retry`). */
  retry: () => void;
  /** What the user is told besides the title; the error's reference follows it. */
  description: ReactNode;
  /** Another way out next to Try again. */
  secondaryAction?: ReactNode;
  /** Spacing from the frame around the page (the shared deck's frame needs less). */
  className?: string;
}

/**
 * The body of an error boundary (`error.tsx`): logs the error for the console, and shows a
 * calm message with its reference (`digest`), a way to try again and, optionally, another
 * way out.
 */
export function PageErrorState({
  error,
  retry,
  description,
  secondaryAction,
  className,
}: PageErrorStateProps) {
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
