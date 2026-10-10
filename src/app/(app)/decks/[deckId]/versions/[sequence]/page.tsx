import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { NotesEditor } from '@/components/deck/notes-editor';
import { TagEditor } from '@/components/deck/tag-editor';
import { parseVersionTab, VersionContent } from '@/components/deck-pages/version-content';
import { versionLabel } from '@/lib/format';
import { noteText } from '@/lib/presentation';
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
  return { title: `${versionLabel(detail.version.sequence)} · ${detail.deck.name}` };
}

/** One version: what changed, the full deck, the primer, tags and notes (all editable by the owner). */
export default async function VersionPage({
  params,
  searchParams,
}: PageProps<'/decks/[deckId]/versions/[sequence]'>) {
  const detail = await loadVersion(params);
  if (detail === null) notFound();
  const { deck, version, snapshot } = detail;
  const tags = await loadTags(deck.id);
  const note = detail.notes.find((entry) => entry.kind === FREE_TEXT_NOTE_KIND) ?? null;
  const primerMarkdown =
    snapshot.primer === null || snapshot.primer === ''
      ? null
      : (await deckServices(deck.id)).primerToMarkdown(deck.source, snapshot.primer);

  return (
    <VersionContent
      scope={{ kind: 'owner', deckId: deck.id }}
      detail={detail}
      tab={parseVersionTab((await searchParams).tab)}
      primerMarkdown={primerMarkdown}
      hasWorking={deck.working !== null}
      tags={
        <TagEditor
          deckId={deck.id}
          sequence={version.sequence}
          tags={version.tags}
          suggestions={tags.map((tag) => tag.name)}
        />
      }
      notes={
        <NotesEditor
          deckId={deck.id}
          sequence={version.sequence}
          text={note === null ? '' : noteText(note.data)}
          updatedAt={note?.updatedAt ?? null}
        />
      }
    />
  );
}
