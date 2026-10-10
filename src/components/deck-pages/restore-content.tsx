import { ChevronLeft, ShieldCheck } from 'lucide-react';
import Link from 'next/link';

import { RestorePanel } from '@/components/deck/restore-panel';
import { VersionBadge } from '@/components/deck/version-row';
import { versionLabel } from '@/lib/format';
import { deckRoutes, type DeckScope } from '@/lib/routes';
import type { SharedRestoreDTO } from '@/server/services/types';

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
      <Link
        href={routes.version(version.sequence)}
        className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 rounded-lg px-2 text-sm font-medium text-muted hover:text-fg md:min-h-9"
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        Back to {versionLabel(version.sequence)}
      </Link>

      <header className="flex flex-col gap-2">
        <div className="flex items-start gap-3">
          <VersionBadge sequence={version.sequence} latest={deck.head?.sequence === version.sequence} />
          <h2 className="min-w-0 text-xl leading-snug font-semibold tracking-tight break-words text-fg">
            Restore {versionLabel(version.sequence)} to Moxfield
          </h2>
        </div>
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
