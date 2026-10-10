import type { ReactNode } from 'react';

import { ButtonLink } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { deckRoutes, type DeckScope } from '@/lib/routes';

export interface NoVersionsYetProps {
  scope: DeckScope;
  icon: ReactNode;
  title: string;
  /** For the owner, who commits v1 on the Status page (linked below it). */
  ownerDescription: string;
  /** For share link viewers, who can only wait for the owner to commit. */
  viewerDescription: string;
}

/**
 * What a deck page shows before the deck has a version: the owner is sent to Status to
 * commit one; viewers are told what will appear.
 */
export function NoVersionsYet({
  scope,
  icon,
  title,
  ownerDescription,
  viewerDescription,
}: NoVersionsYetProps) {
  const owner = scope.kind === 'owner';
  return (
    <EmptyState
      icon={icon}
      title={title}
      description={owner ? ownerDescription : viewerDescription}
      actions={
        owner ? (
          <ButtonLink href={deckRoutes(scope).overview()} variant="primary">
            Go to Status
          </ButtonLink>
        ) : undefined
      }
    />
  );
}
