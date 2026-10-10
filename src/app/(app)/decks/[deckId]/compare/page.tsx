import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import {
  CompareContent,
  compareParam,
  CompareSidesNotFound,
  latestVersionsRefs,
  NothingToCompare,
  type CompareRefs,
} from '@/components/deck-pages/compare-content';
import { versionLabel } from '@/lib/format';
import { deckTitle } from '@/lib/presentation';
import type { DeckOverviewDTO } from '@/server/services/types';

import { deckServices, decodeSegment, loadOverview } from '../data';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps<'/decks/[deckId]/compare'>): Promise<Metadata> {
  const overview = await loadOverview(decodeSegment((await params).deckId));
  return { title: overview === null ? 'Compare' : `Compare · ${deckTitle(overview)}` };
}

/**
 * Default comparison: the latest version against the current Moxfield deck when they
 * differ (what would be committed), otherwise the last two versions.
 */
function defaultRefs(overview: DeckOverviewDTO): CompareRefs | null {
  if (overview.working !== null && overview.status !== 'clean') {
    return { from: overview.head === null ? 'empty' : 'head', to: 'working' };
  }
  return latestVersionsRefs(overview.recentVersions);
}

/** Compare any two versions, the current Moxfield deck, or the empty deck. */
export default async function ComparePage({ params, searchParams }: PageProps<'/decks/[deckId]/compare'>) {
  const deckId = decodeSegment((await params).deckId);
  const query = await searchParams;
  const overview = await loadOverview(deckId);
  if (overview === null) notFound();
  const scope = { kind: 'owner', deckId: overview.id } as const;

  const defaults = defaultRefs(overview);
  if (defaults === null) return <NothingToCompare scope={scope} />;

  const requested = {
    from: compareParam(query.from) ?? defaults.from,
    to: compareParam(query.to) ?? defaults.to,
  };
  const services = await deckServices(deckId);
  const comparison = await services.compare(deckId, requested.from, requested.to);

  if (comparison === null) {
    // The pickers list concrete versions, so `head` is shown as the version it points to.
    const pickerRef = (ref: string): string =>
      ref === 'head' ? (overview.head === null ? 'empty' : versionLabel(overview.head.sequence)) : ref;
    return (
      <CompareSidesNotFound
        scope={scope}
        versions={await services.listVersions(deckId)}
        hasWorking={overview.working !== null}
        defaults={{ from: pickerRef(defaults.from), to: pickerRef(defaults.to) }}
        requested={requested}
      />
    );
  }

  return <CompareContent scope={scope} comparison={comparison} />;
}
