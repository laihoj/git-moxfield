import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { RestoreContent } from '@/components/deck-pages/restore-content';
import { versionLabel } from '@/lib/format';

import { deckServices, decodeSegment, parseSequence } from '../../../data';

export const dynamic = 'force-dynamic';

async function loadRestore(params: PageProps<'/decks/[deckId]/versions/[sequence]/restore'>['params']) {
  const { deckId, sequence: rawSequence } = await params;
  const sequence = parseSequence(rawSequence);
  if (sequence === null) return null;
  const id = decodeSegment(deckId);
  return (await deckServices(id)).restoreExport(id, sequence);
}

export async function generateMetadata({
  params,
}: PageProps<'/decks/[deckId]/versions/[sequence]/restore'>): Promise<Metadata> {
  const restore = await loadRestore(params);
  if (restore === null) return { title: 'Version not found' };
  return { title: `Restore ${versionLabel(restore.version.sequence)} · ${restore.deck.name}` };
}

/** Restore a version to Moxfield: copy blocks per Bulk Edit board, steps and limitations. */
export default async function RestorePage({
  params,
}: PageProps<'/decks/[deckId]/versions/[sequence]/restore'>) {
  const restore = await loadRestore(params);
  if (restore === null) notFound();
  return (
    <RestoreContent
      scope={{ kind: 'owner', deckId: restore.deck.id }}
      restore={restore}
      deckUrl={restore.deck.url}
    />
  );
}
