import { Compass } from 'lucide-react';
import type { Metadata } from 'next';

import { ButtonLink } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { routes } from '@/lib/routes';

import { AppChrome } from './app-chrome';

export const metadata: Metadata = { title: 'Not found' };

/**
 * Friendly 404 for unknown pages, decks, versions and cards, in the app's frame. (Share
 * link pages have their own: `s/not-found.tsx` and `s/[token]/not-found.tsx`.)
 */
export default function NotFound() {
  return (
    <AppChrome>
      <EmptyState
        className="mx-auto mt-6 max-w-xl"
        headingLevel={1}
        icon={<Compass aria-hidden="true" />}
        title="We couldn’t find that"
        description="The deck, version or card may have been removed, or the link is mistyped."
        actions={
          <ButtonLink href={routes.home()} variant="primary">
            Back to your decks
          </ButtonLink>
        }
      />
    </AppChrome>
  );
}
