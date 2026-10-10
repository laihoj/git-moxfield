import { ChevronLeft, ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { RestorePanel } from '@/components/deck/restore-panel';
import { VersionBadge } from '@/components/deck/version-row';
import { versionLabel } from '@/lib/format';
import { routes } from '@/lib/routes';
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
  const { deck, version } = restore;

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <Link
        href={routes.version(deck.id, version.sequence)}
        className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 rounded-lg px-2 text-sm font-medium text-muted hover:text-fg md:min-h-9"
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        Back to {versionLabel(version.sequence)}
      </Link>

      <header className="flex flex-col gap-2">
        <div className="flex items-start gap-3">
          <VersionBadge sequence={version.sequence} latest={deck.head?.sequence === version.sequence} />
          <h2 className="min-w-0 text-xl leading-snug font-semibold tracking-tight break-words text-fg">
            Restore {versionLabel(version.sequence)} to Moxfield
          </h2>
        </div>
        <p className="text-sm break-words text-muted">{version.message}</p>
        <p className="flex items-start gap-2 text-sm text-muted">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-add" />
          <span>
            git-moxfield never writes to Moxfield. You paste each block into Moxfield&apos;s Bulk Edit and
            save there. Afterwards the restored deck shows up here as uncommitted changes.
          </span>
        </p>
      </header>

      <RestorePanel
        restore={restore.export}
        deckUrl={deck.url}
        downloadHref={routes.restoreText(deck.id, version.sequence)}
      />
    </div>
  );
}
