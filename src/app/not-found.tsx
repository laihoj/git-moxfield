import { Compass } from 'lucide-react';
import type { Metadata } from 'next';

import { ButtonLink } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

export const metadata: Metadata = { title: 'Not found' };

/** Friendly 404 for unknown pages, decks, versions and cards. */
export default function NotFound() {
  return (
    <EmptyState
      className="mx-auto mt-6 max-w-xl"
      headingLevel={1}
      icon={<Compass aria-hidden="true" />}
      title="We couldn’t find that"
      description="The deck, version or card may have been removed, or the link is mistyped."
      actions={
        <ButtonLink href="/" variant="primary">
          Back to your decks
        </ButtonLink>
      }
    />
  );
}
