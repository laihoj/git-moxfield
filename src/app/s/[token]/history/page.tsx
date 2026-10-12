import { HistoryContent, historyTagParam } from '@/components/deck-pages/history-content';
import { sharedDeckRoutes } from '@/lib/routes';

import { findSharedOverview, loadSharedDeck, sharedSectionMetadata } from '../data';
import { SharedPageMissing } from '../page-missing';

export const dynamic = 'force-dynamic';

export const generateMetadata = sharedSectionMetadata('History');

/** Every committed version of a shared deck, newest first, with a tag filter and compare selection. */
export default async function SharedHistoryPage({ params, searchParams }: PageProps<'/s/[token]/history'>) {
  const { token } = await params;
  const tag = historyTagParam((await searchParams).tag);
  const access = await loadSharedDeck(token);
  if (access === null) return <SharedPageMissing access={access} />;
  const [overview, tags, versions] = await Promise.all([
    findSharedOverview(token),
    access.services.listTags(),
    access.services.listVersions({ tag }),
  ]);
  if (overview === null) return <SharedPageMissing access={access} />;

  return (
    <HistoryContent
      scope={sharedDeckRoutes(token).scope}
      versions={versions}
      tags={tags}
      tag={tag}
      versionCount={overview.versionCount}
      headSequence={overview.head?.sequence ?? null}
      hasWorking={false}
    />
  );
}
