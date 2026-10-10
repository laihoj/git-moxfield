'use client';

import { SearchX } from 'lucide-react';
import { useParams } from 'next/navigation';

import { ButtonLink } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { sharedDeckRoutes } from '@/lib/routes';

/**
 * A page of a working share link that does not exist: a version, card or page the shared
 * deck does not have. Shown inside the deck's frame. (A link that does not work at all
 * gets `../not-found.tsx` instead: pages never answer it with `notFound()`, see
 * `./page-missing.tsx`.)
 */
export default function SharedPageNotFound() {
  const { token } = useParams<{ token: string }>();
  return (
    <EmptyState
      className="mx-auto mt-2 max-w-xl"
      headingLevel={1}
      icon={<SearchX aria-hidden="true" />}
      title="We couldn’t find that"
      description="This version, card or page is not part of the shared deck. The link may be mistyped."
      actions={
        <ButtonLink href={sharedDeckRoutes(token).overview()} variant="primary">
          Back to the deck
        </ButtonLink>
      }
    />
  );
}
