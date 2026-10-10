import { SharedOverviewContent } from '@/components/deck-pages/shared-overview-content';
import { sharedDeckRoutes } from '@/lib/routes';

import { findSharedOverview, loadSharedDeck } from './data';
import { SharedPageMissing } from './page-missing';

export const dynamic = 'force-dynamic';

/** A shared deck's first page: its latest version and what changed, beside the recent versions. */
export default async function SharedOverviewPage({ params }: PageProps<'/s/[token]'>) {
  const { token } = await params;
  const access = await loadSharedDeck(token);
  const overview = access === null ? null : await findSharedOverview(token);
  if (access === null || overview === null) return <SharedPageMissing access={access} />;
  const latest = overview.head === null ? null : await access.services.getVersion(overview.head.sequence);
  return <SharedOverviewContent scope={sharedDeckRoutes(token).scope} overview={overview} latest={latest} />;
}
