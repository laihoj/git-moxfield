import { ChevronRight, TriangleAlert } from 'lucide-react';

import type { DeckSummaryDTO } from '@/server/services/types';
import { Card } from '@/components/ui/card';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { Link } from '@/components/ui/navigation';
import { RelativeTime } from '@/components/ui/relative-time';
import { versionLabel } from '@/lib/format';
import {
  currentFetchError,
  deckTitle,
  describeFetchError,
  describeStatus,
  isUnnamedDeck,
} from '@/lib/presentation';
import { routes } from '@/lib/routes';

import { DiffStatsInline } from './diff-stats';
import { StatusIndicator } from './status-indicator';

/** A tracked deck in the deck list: name, commanders, status, latest version and Moxfield activity. */
export function DeckCard({ deck }: { deck: DeckSummaryDTO }) {
  const { label, tone } = describeStatus(deck.status, deck.head);
  const error = currentFetchError(deck);
  const unnamed = isUnnamedDeck(deck);
  return (
    <Card
      as="li"
      flush
      className="group relative flex transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-pop"
    >
      <div className="min-w-0 flex-1 p-4 md:p-5">
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 text-base font-semibold break-words text-fg">
            <Link
              href={routes.deck(deck.id)}
              className="outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-accent"
            >
              {deckTitle(deck)}
            </Link>
          </h3>
          {deck.head !== null && (
            <MetaList aria-label="Latest version" className="shrink-0 pt-0.5 text-xs text-muted tabular">
              <MetaItem className="font-semibold text-fg">{versionLabel(deck.head.sequence)}</MetaItem>
              <MetaItem>
                <RelativeTime value={deck.head.createdAt} style="short" />
              </MetaItem>
            </MetaList>
          )}
        </div>
        {unnamed && (
          <p className="mt-0.5 font-mono text-[0.8125rem] break-all text-muted">{deck.externalId}</p>
        )}
        {!unnamed && deck.commanders.length > 0 && (
          <MetaList aria-label="Commanders" className="mt-0.5 text-sm text-muted">
            {deck.commanders.map((commander) => (
              <MetaItem key={commander}>{commander}</MetaItem>
            ))}
          </MetaList>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="inline-flex items-start gap-1.5 font-medium text-fg">
            <StatusIndicator tone={tone} className="mt-0.5" />
            {label}
          </span>
          {deck.workingStats !== null && deck.status === 'uncommitted' && (
            <DiffStatsInline stats={deck.workingStats} />
          )}
        </div>
        {deck.working?.sourceUpdatedAt != null && (
          <p className="mt-1 text-xs text-muted">
            Moxfield edited <RelativeTime value={deck.working.sourceUpdatedAt} />
          </p>
        )}
        {error !== null && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-warn">
            <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            {describeFetchError(error.code)}
          </p>
        )}
      </div>
      <ChevronRight
        aria-hidden="true"
        className="mr-3 size-5 shrink-0 self-center text-subtle transition-transform group-hover:translate-x-0.5"
      />
    </Card>
  );
}
