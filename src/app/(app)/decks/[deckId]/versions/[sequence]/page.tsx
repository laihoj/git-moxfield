import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { NotesEditor } from '@/components/deck/notes-editor';
import { TagEditor } from '@/components/deck/tag-editor';
import { parseVersionTab, VersionContent } from '@/components/deck-pages/version-content';
import { rankTagSuggestions } from '@/core/tags';
import { versionLabel } from '@/lib/format';
import { deckPageTitle, deckTitle, freeTextNote } from '@/lib/presentation';
import { FREE_TEXT_NOTE_KIND } from '@/server/services';

import { deckServices, decodeSegment, loadTags, parseSequence } from '../../data';

export const dynamic = 'force-dynamic';

async function loadVersion(params: PageProps<'/decks/[deckId]/versions/[sequence]'>['params']) {
  const { deckId: rawDeckId, sequence: rawSequence } = await params;
  const deckId = decodeSegment(rawDeckId);
  const sequence = parseSequence(rawSequence);
  if (sequence === null) return null;
  return (await deckServices(deckId)).getVersion(deckId, sequence);
}

export async function generateMetadata({
  params,
}: PageProps<'/decks/[deckId]/versions/[sequence]'>): Promise<Metadata> {
  const detail = await loadVersion(params);
  if (detail === null) return { title: 'Version not found' };
  return { title: deckPageTitle(versionLabel(detail.version.sequence), deckTitle(detail.deck)) };
}

/** One version: what changed, the full deck, the primer, tags and notes (all editable by the owner). */
export default async function VersionPage({
  params,
  searchParams,
}: PageProps<'/decks/[deckId]/versions/[sequence]'>) {
  const detail = await loadVersion(params);
  if (detail === null) notFound();
  const { deck, version } = detail;
  const tags = await loadTags(deck.id);
  const note = freeTextNote(detail.notes, FREE_TEXT_NOTE_KIND);

  return (
    <VersionContent
      scope={{ kind: 'owner', deckId: deck.id }}
      detail={detail}
      tab={parseVersionTab((await searchParams).tab)}
      hasWorking={deck.working !== null}
      tags={
        <TagEditor
          deckId={deck.id}
          sequence={version.sequence}
          tags={version.tags}
          suggestions={rankTagSuggestions(tags)}
        />
      }
      notes={
        <NotesEditor
          deckId={deck.id}
          sequence={version.sequence}
          text={note.text}
          updatedAt={note.updatedAt}
        />
      }
    />
  );
}
