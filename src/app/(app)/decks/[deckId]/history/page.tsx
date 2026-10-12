import { notFound } from 'next/navigation';

import { HistoryContent, historyTagParam } from '@/components/deck-pages/history-content';

import { deckServices, decodeSegment, loadOverview, loadTags, ownerSectionMetadata } from '../data';

export const dynamic = 'force-dynamic';

export const generateMetadata = ownerSectionMetadata('History');

/** All versions of a deck, newest first, with a tag filter and compare selection. */
export default async function HistoryPage({ params, searchParams }: PageProps<'/decks/[deckId]/history'>) {
  const deckId = decodeSegment((await params).deckId);
  const tag = historyTagParam((await searchParams).tag);

  const [overview, tags, versions] = await Promise.all([
    loadOverview(deckId),
    loadTags(deckId),
    deckServices(deckId).then((services) => services.listVersions(deckId, { tag })),
  ]);
  if (overview === null) notFound();

  return (
    <HistoryContent
      scope={{ kind: 'owner', deckId: overview.id }}
      versions={versions}
      tags={tags}
      tag={tag}
      versionCount={overview.versionCount}
      headSequence={overview.head?.sequence ?? null}
      hasWorking={overview.working !== null}
    />
  );
}
