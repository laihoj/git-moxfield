import type { Metadata } from 'next';
import { cache } from 'react';

import { RestoreContent } from '@/components/deck-pages/restore-content';
import { parseSequence } from '@/app/route-segments';
import { versionLabel } from '@/lib/format';
import { deckPageTitle, sharedDeckTitle } from '@/lib/presentation';
import { sharedDeckRoutes } from '@/lib/routes';

import { loadSharedDeck, sharedPageMetadata } from '../../../data';
import { SharedPageMissing } from '../../../page-missing';

export const dynamic = 'force-dynamic';

/** The version's restore export, once per request (metadata and page); `null` when not found. */
const loadRestore = cache(async (token: string, rawSequence: string) => {
  const sequence = parseSequence(rawSequence);
  const access = sequence === null ? null : await loadSharedDeck(token);
  return access === null || sequence === null ? null : access.services.restoreExport(sequence);
});

export async function generateMetadata({
  params,
}: PageProps<'/s/[token]/versions/[sequence]/restore'>): Promise<Metadata> {
  const { token, sequence } = await params;
  return sharedPageMetadata(token, async () => {
    const restore = await loadRestore(token, sequence);
    if (restore === null) return { title: 'Version not found' };
    return {
      title: deckPageTitle(
        `Restore ${versionLabel(restore.version.sequence)}`,
        sharedDeckTitle(restore.deck),
      ),
    };
  });
}

/** Copy a version of a shared deck to Moxfield: copy blocks per Bulk Edit board, steps and limitations. */
export default async function SharedRestorePage({
  params,
}: PageProps<'/s/[token]/versions/[sequence]/restore'>) {
  const { token, sequence } = await params;
  const restore = await loadRestore(token, sequence);
  if (restore === null) return <SharedPageMissing access={await loadSharedDeck(token)} />;
  // No `deckUrl`: viewers restore into a deck of their own, never the owner's.
  return <RestoreContent scope={sharedDeckRoutes(token).scope} restore={restore} />;
}
