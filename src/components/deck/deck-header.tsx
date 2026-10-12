import clsx from 'clsx';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { ExternalLink } from '@/components/ui/external-link';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { formatLabel } from '@/lib/presentation';

export interface DeckHeaderProps {
  /** The deck's title (see `deckTitle`). */
  name: string;
  /** Moxfield public id, shown under the title while the deck has no name yet. */
  unnamedId?: string;
  commanders: readonly string[];
  format: string;
  /**
   * Deck URL on Moxfield, for its owner only. Share link viewers get none: the URL opens
   * the live deck, uncommitted changes included (ADR 0007).
   */
  url?: string;
  /** Controls before the Moxfield link (the owner's Share button). */
  actions?: ReactNode;
}

/**
 * Deck name, then its format as a quiet badge followed by the commanders, and (for the
 * owner) a link to the deck on Moxfield (new tab), after the owner's controls.
 */
export function DeckHeader({ name, unnamedId, commanders, format, url, actions }: DeckHeaderProps) {
  const formatText = formatLabel(format);
  const hasControls = actions !== undefined || url !== undefined;
  return (
    <header>
      <div className="flex items-start justify-between gap-4">
        <h1 className="min-w-0 text-2xl leading-tight font-semibold tracking-tight text-balance break-words text-fg md:text-[1.75rem]">
          {name}
        </h1>
        {hasControls && (
          <div className="flex shrink-0 items-center gap-1">
            {actions}
            {url !== undefined && <MoxfieldLink url={url} />}
          </div>
        )}
      </div>
      {unnamedId !== undefined && (
        <p className="mt-1 text-sm break-all text-muted">
          Moxfield id <span className="font-mono text-[0.8125rem] text-fg/80">{unnamedId}</span>
        </p>
      )}
      {(formatText !== '' || commanders.length > 0) && (
        <div className="mt-1.5 flex items-baseline gap-2.5">
          {formatText !== '' && (
            <Badge tone="neutral" className="shrink-0">
              {formatText}
            </Badge>
          )}
          {commanders.length > 0 && (
            <MetaList aria-label="Commanders" className="min-w-0 text-sm text-fg/80">
              {commanders.map((commander) => (
                <MetaItem key={commander}>{commander}</MetaItem>
              ))}
            </MetaList>
          )}
        </div>
      )}
    </header>
  );
}

/**
 * A quiet text link of the deck header (Moxfield, Share); the pseudo-element extends its
 * hit area to 44px on touch screens.
 */
export const DECK_HEADER_LINK =
  "relative inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2.5 text-sm font-medium transition-colors after:absolute after:-inset-1.5 after:content-[''] hover:bg-surface-2 hover:text-fg md:after:hidden";

function MoxfieldLink({ url }: { url: string }) {
  return (
    <ExternalLink href={url} className={clsx(DECK_HEADER_LINK, '-mr-2.5 text-muted')}>
      Moxfield
    </ExternalLink>
  );
}
