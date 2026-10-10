import type { Metadata } from 'next';

import { HistoryContent } from '@/components/deck-pages/history-content';
import { sharedDeckTitle } from '@/lib/presentation';
import { sharedDeckRoutes } from '@/lib/routes';

import { findSharedOverview, loadSharedDeck, sharedPageMetadata } from '../data';
import { SharedPageMissing } from '../page-missing';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps<'/s/[token]/history'>): Promise<Metadata> {
  const { token } = await params;
  return sharedPageMetadata(token, async () => {
    const overview = await findSharedOverview(token);
    return { title: overview === null ? 'History' : `History · ${sharedDeckTitle(overview)}` };
  });
}

/** Every committed version of a shared deck, newest first, with a tag filter and compare selection. */
export default async function SharedHistoryPage({ params, searchParams }: PageProps<'/s/[token]/history'>) {
  const { token } = await params;
  const { tag: tagParam } = await searchParams;
  const tag = typeof tagParam === 'string' && tagParam.trim() !== '' ? tagParam.trim() : undefined;
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
