import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { HistoryContent } from '@/components/deck-pages/history-content';
import { deckTitle } from '@/lib/presentation';

import { deckServices, decodeSegment, loadOverview, loadTags } from '../data';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps<'/decks/[deckId]/history'>): Promise<Metadata> {
  const overview = await loadOverview(decodeSegment((await params).deckId));
  return { title: overview === null ? 'History' : `History · ${deckTitle(overview)}` };
}

/** All versions of a deck, newest first, with a tag filter and compare selection. */
export default async function HistoryPage({ params, searchParams }: PageProps<'/decks/[deckId]/history'>) {
  const deckId = decodeSegment((await params).deckId);
  const { tag: tagParam } = await searchParams;
  const tag = typeof tagParam === 'string' && tagParam.trim() !== '' ? tagParam.trim() : undefined;

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
