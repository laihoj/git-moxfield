import type { Metadata } from 'next';
import { cache } from 'react';

import { VersionNote } from '@/components/deck/version-note';
import { VersionTags } from '@/components/deck/version-tags';
import { parseVersionTab, VersionContent } from '@/components/deck-pages/version-content';
import { parseSequence } from '@/app/route-segments';
import { versionLabel } from '@/lib/format';
import { noteText, sharedDeckTitle } from '@/lib/presentation';
import { sharedDeckRoutes } from '@/lib/routes';
import { FREE_TEXT_NOTE_KIND } from '@/server/services';

import { loadSharedDeck, sharedPageMetadata } from '../../data';
import { SharedPageMissing } from '../../page-missing';

export const dynamic = 'force-dynamic';

/** The version and the link's access, once per request (metadata and page); `null` when not found. */
const loadVersion = cache(async (token: string, rawSequence: string) => {
  const sequence = parseSequence(rawSequence);
  const access = sequence === null ? null : await loadSharedDeck(token);
  if (access === null || sequence === null) return null;
  const detail = await access.services.getVersion(sequence);
  return detail === null ? null : { access, detail };
});

export async function generateMetadata({
  params,
}: PageProps<'/s/[token]/versions/[sequence]'>): Promise<Metadata> {
  const { token, sequence } = await params;
  return sharedPageMetadata(token, async () => {
    const found = await loadVersion(token, sequence);
    if (found === null) return { title: 'Version not found' };
    const { detail } = found;
    return { title: `${versionLabel(detail.version.sequence)} · ${sharedDeckTitle(detail.deck)}` };
  });
}

/**
 * One version of a shared deck, read-only: what changed, the full deck, the primer, its
 * tags, and its notes when the link includes them.
 */
export default async function SharedVersionPage({
  params,
  searchParams,
}: PageProps<'/s/[token]/versions/[sequence]'>) {
  const { token, sequence } = await params;
  const found = await loadVersion(token, sequence);
  if (found === null) return <SharedPageMissing access={await loadSharedDeck(token)} />;
  const { access, detail } = found;
  const { deck, version, snapshot } = detail;
  const note = detail.notes.find((entry) => entry.kind === FREE_TEXT_NOTE_KIND) ?? null;
  const primerMarkdown =
    snapshot.primer === null || snapshot.primer === ''
      ? null
      : access.services.primerToMarkdown(deck.source, snapshot.primer);

  return (
    <VersionContent
      scope={sharedDeckRoutes(token).scope}
      detail={detail}
      tab={parseVersionTab((await searchParams).tab)}
      primerMarkdown={primerMarkdown}
      hasWorking={false}
      tags={<VersionTags tags={version.tags} />}
      notes={
        access.share.includeNotes ? (
          <VersionNote text={note === null ? '' : noteText(note.data)} updatedAt={note?.updatedAt ?? null} />
        ) : undefined
      }
    />
  );
}
