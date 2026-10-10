import { ArrowUpRight } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { formatLabel } from '@/lib/presentation';

export interface DeckHeaderProps {
  /** The deck's title (see `deckTitle`). */
  name: string;
  /** Moxfield public id, shown under the title while the deck has no name yet. */
  unnamedId?: string;
  commanders: readonly string[];
  format: string;
  /** Deck URL on Moxfield. */
  url: string;
}

/**
 * Deck name, then its format as a quiet badge followed by the commanders, and a link to
 * the deck on Moxfield (new tab).
 */
export function DeckHeader({ name, unnamedId, commanders, format, url }: DeckHeaderProps) {
  const formatText = formatLabel(format);
  return (
    <header>
      <div className="flex items-start justify-between gap-4">
        <h1 className="min-w-0 text-2xl leading-tight font-semibold tracking-tight text-balance break-words text-fg md:text-[1.75rem]">
          {name}
        </h1>
        <MoxfieldLink url={url} />
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

function MoxfieldLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="relative -mr-2.5 inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2.5 text-sm font-medium text-muted transition-colors after:absolute after:-inset-1.5 after:content-[''] hover:bg-surface-2 hover:text-fg md:after:hidden"
    >
      Moxfield
      <ArrowUpRight aria-hidden="true" className="size-4" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}
