import { ShieldCheck } from 'lucide-react';

import { RestorePanel } from '@/components/deck/restore-panel';
import { VersionTitle } from '@/components/deck/version-row';
import { versionLabel } from '@/lib/format';
import { deckRoutes, type DeckScope } from '@/lib/routes';
import type { SharedRestoreDTO } from '@/server/services/types';
import { BackLink } from '@/components/ui/back-link';

export interface RestoreContentProps {
  scope: DeckScope;
  /** The restore export (an owner's `RestoreDTO` fits too). */
  restore: SharedRestoreDTO;
  /**
   * The deck on Moxfield, for its owner, who restores it there. Share link viewers get
   * none: they copy the version into a deck of their own, and the owner's deck URL would
   * show them its live state (ADR 0007).
   */
  deckUrl?: string;
}

/**
 * Restore a version to Moxfield: copy blocks per Bulk Edit board, steps, limitations and
 * the plain-text download. The owner restores their own deck; a share link viewer copies
 * the version into a deck of their own.
 */
export function RestoreContent({ scope, restore, deckUrl }: RestoreContentProps) {
  const { deck, version } = restore;
  const routes = deckRoutes(scope);
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <BackLink href={routes.version(version.sequence)}>Back to {versionLabel(version.sequence)}</BackLink>

      <header className="flex flex-col gap-2">
        <VersionTitle sequence={version.sequence} latest={deck.head?.sequence === version.sequence}>
          Restore {versionLabel(version.sequence)} to Moxfield
        </VersionTitle>
        <p className="text-sm break-words text-muted">{version.message}</p>
        <p className="flex items-start gap-2 text-sm text-muted">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-add" />
          {scope.kind === 'owner' ? (
            <span>
              git-moxfield never writes to Moxfield. You paste each block into Moxfield&apos;s Bulk Edit and
              save there. Afterwards the restored deck shows up here as uncommitted changes.
            </span>
          ) : (
            <span>
              git-moxfield never writes to Moxfield. To build this version there, paste each block into the
              Bulk Edit of a deck of your own, or start a new deck from the combined list at the end.
            </span>
          )}
        </p>
      </header>

      <RestorePanel
        restore={restore.export}
        deckUrl={deckUrl}
        downloadHref={routes.restoreText(version.sequence)}
      />
    </div>
  );
}
