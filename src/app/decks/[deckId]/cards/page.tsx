import { ChevronRight, Search, SearchX } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CardSearch } from '@/components/deck/card-search';
import { ManaCost } from '@/components/deck/mana-cost';
import { ZoneBadge } from '@/components/deck/zone-badge';
import { ButtonLink } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { pluralize, versionLabel } from '@/lib/format';
import { deckTitle } from '@/lib/presentation';
import { routes } from '@/lib/routes';
import { deckServices, decodeSegment, loadOverview } from '../data';

export const dynamic = 'force-dynamic';

const RESULT_LIMIT = 50;

export async function generateMetadata({ params }: PageProps<'/decks/[deckId]/cards'>): Promise<Metadata> {
  const overview = await loadOverview(decodeSegment((await params).deckId));
  return { title: overview === null ? 'Cards' : `Cards · ${deckTitle(overview)}` };
}

/** Search every card that was ever in the deck; each result links to its card history. */
export default async function CardsPage({ params, searchParams }: PageProps<'/decks/[deckId]/cards'>) {
  const deckId = decodeSegment((await params).deckId);
  const { q } = await searchParams;
  const query = typeof q === 'string' ? q.trim().slice(0, 200) : '';
  const overview = await loadOverview(deckId);
  if (overview === null) notFound();

  if (overview.versionCount === 0) {
    return (
      <EmptyState
        icon={<Search aria-hidden="true" />}
        title="No versions to search yet"
        description="Card search covers every committed version. Review the current Moxfield deck on the Status page and commit it as v1."
        actions={
          <ButtonLink href={routes.deck(overview.id)} variant="primary">
            Go to Status
          </ButtonLink>
        }
      />
    );
  }

  const results =
    query === '' ? [] : await (await deckServices(deckId)).searchCards(deckId, query, RESULT_LIMIT);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-fg">Cards</h2>
        <p className="text-sm text-muted">
          {overview.versionCount === 1
            ? 'Find a card in v1 and see its history.'
            : `Find a card across all ${pluralize(overview.versionCount, 'version')} and see its history.`}
        </p>
      </div>

      <CardSearch key={query} deckId={overview.id} query={query} />

      {query === '' ? (
        <p className="px-1 text-sm text-muted">
          Try a card you cut a while ago. Results include cards that are no longer in the deck.
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
            {results.length === RESULT_LIMIT
              ? `First ${RESULT_LIMIT} matches`
              : pluralize(results.length, 'match', 'matches')}
          </p>
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-card">
            {results.map((result) => (
              <li
                key={result.key}
                className="relative flex items-center gap-3 px-4 py-3 hover:bg-surface-2/70 md:px-5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <Link
                      href={routes.card(overview.id, result.key)}
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
          </ul>
        </section>
      )}
    </div>
  );
}
