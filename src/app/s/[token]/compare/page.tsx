import {
  CompareContent,
  CompareSidesNotFound,
  latestVersionsRefs,
  NothingToCompare,
  requestedRefs,
} from '@/components/deck-pages/compare-content';
import { sharedDeckRoutes } from '@/lib/routes';

import { findSharedOverview, loadSharedDeck, sharedSectionMetadata } from '../data';
import { SharedPageMissing } from '../page-missing';

export const dynamic = 'force-dynamic';

export const generateMetadata = sharedSectionMetadata('Compare');

/**
 * Compare any two committed versions of a shared deck, or a version with the empty deck.
 * Viewers never see the current Moxfield deck, so it is neither a side nor a default.
 */
export default async function SharedComparePage({ params, searchParams }: PageProps<'/s/[token]/compare'>) {
  const { token } = await params;
  const query = await searchParams;
  const access = await loadSharedDeck(token);
  const overview = access === null ? null : await findSharedOverview(token);
  if (access === null || overview === null) return <SharedPageMissing access={access} />;
  const { services } = access;
  const scope = sharedDeckRoutes(token).scope;

  const defaults = latestVersionsRefs(overview.recentVersions);
  if (defaults === null) return <NothingToCompare scope={scope} />;

  const requested = requestedRefs(query, defaults);
  const comparison = await services.compare(requested.from, requested.to);
  if (comparison === null) {
    return (
      <CompareSidesNotFound
        scope={scope}
        versions={await services.listVersions()}
        hasWorking={false}
        defaults={defaults}
        requested={requested}
      />
    );
  }
  return <CompareContent scope={scope} comparison={comparison} />;
}
