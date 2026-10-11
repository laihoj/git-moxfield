import { ChevronRight, Search, SearchX } from 'lucide-react';

import { CardSearch } from '@/components/deck/card-search';
import { ManaCost } from '@/components/deck/mana-cost';
import { ZoneBadge } from '@/components/deck/zone-badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { Link } from '@/components/ui/navigation';
import { MAX_CARD_QUERY_LENGTH } from '@/core/text-limits';
import { pluralize, versionLabel } from '@/lib/format';
import { deckRoutes, type DeckScope } from '@/lib/routes';
import { searchParamText } from '@/lib/search-params';
import type { CardSearchResultDTO } from '@/server/services/types';

import { NoVersionsYet } from './no-versions-yet';

/** Most results a card search shows. */
export const CARD_RESULT_LIMIT = 50;

/** The parsed `?q=` of the Cards page: trimmed and bounded; `''` for no search. */
export function cardQuery(value: string | string[] | undefined): string {
  return searchParamText(value, MAX_CARD_QUERY_LENGTH) ?? '';
}

/** The results of a card search: none without a query or without versions to search. */
export async function cardResults(
  query: string,
  versionCount: number,
  search: (query: string) => Promise<CardSearchResultDTO[]>,
): Promise<CardSearchResultDTO[]> {
  return query === '' || versionCount === 0 ? [] : search(query);
}

export interface CardsContentProps {
  scope: DeckScope;
  /** The search (`''` before one). */
  query: string;
  versionCount: number;
  /** Matches of `query` (at most {@link CARD_RESULT_LIMIT}). */
  results: readonly CardSearchResultDTO[];
}

/** The Cards page: search every card that was ever in the deck; each result links to its card history. */
export function CardsContent({ scope, query, versionCount, results }: CardsContentProps) {
  if (versionCount === 0) {
    return (
      <NoVersionsYet
        scope={scope}
        icon={<Search aria-hidden="true" />}
        title="No versions to search yet"
        ownerDescription="Card search covers every committed version. Review the current Moxfield deck on the Status page and commit it as v1."
        viewerDescription="Card search covers every committed version of this deck. There is none yet."
      />
    );
  }

  const routes = deckRoutes(scope);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-fg">Cards</h2>
        <p className="text-sm text-muted">
          {versionCount === 1
            ? 'Find a card in v1 and see its history.'
            : `Find a card across all ${pluralize(versionCount, 'version')} and see its history.`}
        </p>
      </div>

      <CardSearch key={query} scope={scope} query={query} />

      {query === '' ? (
        <p className="px-1 text-sm text-muted">
          Try a card {scope.kind === 'owner' ? 'you cut' : 'that was cut'} a while ago. Results include cards
          that are no longer in the deck.
        </p>
      ) : results.length === 0 ? (
        <EmptyState
          icon={<SearchX aria-hidden="true" />}
          title={`No cards match “${query}”`}
          description="No card with a matching name was ever in this deck. Search ignores case and accents."
        />
      ) : (
        <section aria-label="Search results">
          <p className="mb-2 px-1 text-xs text-muted" role="status">
            {results.length === CARD_RESULT_LIMIT
              ? `First ${CARD_RESULT_LIMIT} matches`
              : pluralize(results.length, 'match', 'matches')}
          </p>
          <Card as="ul" flush className="divide-y divide-border overflow-hidden">
            {results.map((result) => (
              <li
                key={result.key}
                className="relative flex items-center gap-3 px-4 py-3 hover:bg-surface-2/70 md:px-5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <Link
                      href={routes.card(result.key)}
                      className="min-w-0 text-sm font-medium break-words text-fg outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
                    >
                      {result.name}
                    </Link>
                    {result.facts !== null && (
                      <ManaCost cost={result.facts.manaCost} className="mt-0.5 shrink-0" />
                    )}
                  </div>
                  {result.facts !== null && result.facts.typeLine !== '' && (
                    <p className="mt-0.5 text-xs break-words text-muted">{result.facts.typeLine}</p>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                    {result.headZones.map(({ zone, quantity }) => (
                      <ZoneBadge key={zone} zone={zone} quantity={quantity > 1 ? quantity : undefined} />
                    ))}
                    <MetaList className="tabular">
                      {result.headZones.length === 0 && <MetaItem>Not in the latest version</MetaItem>}
                      {result.headZones.length === 0 && result.lastSeenSequence !== null && (
                        <MetaItem>last in {versionLabel(result.lastSeenSequence)}</MetaItem>
                      )}
                      <MetaItem>In {pluralize(result.versionsPresent, 'version')}</MetaItem>
                    </MetaList>
                  </div>
                </div>
                <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-subtle" />
              </li>
            ))}
          </Card>
        </section>
      )}
    </div>
  );
}
