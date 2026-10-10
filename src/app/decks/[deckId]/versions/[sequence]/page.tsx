import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  FileText,
  Hash,
  History,
  LayoutList,
  ListTree,
  Undo2,
} from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { CompareMenu, type CompareMenuItem } from '@/components/deck/compare-menu';
import { DeckList } from '@/components/deck/deck-list';
import { DiffView, initialPlayedCount } from '@/components/deck/diff-view';
import { NotesEditor } from '@/components/deck/notes-editor';
import { PrimerDiffView } from '@/components/deck/primer-diff-view';
import { PrimerView } from '@/components/deck/primer-view';
import { SummaryChips } from '@/components/deck/summary-chips';
import { TagEditor } from '@/components/deck/tag-editor';
import { VersionBadge } from '@/components/deck/version-row';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { Disclosure } from '@/components/ui/disclosure';
import { AbsoluteTime, RelativeTime } from '@/components/ui/relative-time';
import { SegmentedLinks } from '@/components/ui/tabs';
import { diffChangeCount } from '@/core/diff';
import { playedCardCount } from '@/core/canonical';
import { pluralize, versionLabel } from '@/lib/format';
import { describeIngestMethod, noteText } from '@/lib/presentation';
import { routes, type VersionTab } from '@/lib/routes';
import { FREE_TEXT_NOTE_KIND, getServices } from '@/server/services';

import { decodeSegment, loadTags, parseSequence } from '../../data';

export const dynamic = 'force-dynamic';

function parseTab(value: string | string[] | undefined): VersionTab {
  return value === 'deck' || value === 'primer' ? value : 'changes';
}

async function loadVersion(params: PageProps<'/decks/[deckId]/versions/[sequence]'>['params']) {
  const { deckId: rawDeckId, sequence: rawSequence } = await params;
  const deckId = decodeSegment(rawDeckId);
  const sequence = parseSequence(rawSequence);
  if (sequence === null) return null;
  return getServices().getVersion(deckId, sequence);
}

export async function generateMetadata({
  params,
}: PageProps<'/decks/[deckId]/versions/[sequence]'>): Promise<Metadata> {
  const detail = await loadVersion(params);
  if (detail === null) return { title: 'Version not found' };
  return { title: `${versionLabel(detail.version.sequence)} · ${detail.deck.name}` };
}

/** One version: what changed, the full deck, the primer, tags and notes. */
export default async function VersionPage({
  params,
  searchParams,
}: PageProps<'/decks/[deckId]/versions/[sequence]'>) {
  const detail = await loadVersion(params);
  if (detail === null) notFound();
  const { deck, version, snapshot, diff, primerDiff, catalog, previous, next } = detail;
  const tab = parseTab((await searchParams).tab);
  const tags = await loadTags(deck.id);
  const note = detail.notes.find((entry) => entry.kind === FREE_TEXT_NOTE_KIND) ?? null;
  const isLatest = deck.head?.sequence === version.sequence;
  const initial = version.parentSequence === null;
  const primerMarkdown =
    snapshot.primer === null || snapshot.primer === ''
      ? null
      : getServices().primerToMarkdown(deck.source, snapshot.primer);

  const compareItems: CompareMenuItem[] = [];
  if (previous !== null) {
    compareItems.push({
      label: `With previous (${versionLabel(previous.sequence)})`,
      detail: previous.message,
      href: routes.compare(deck.id, {
        from: versionLabel(previous.sequence),
        to: versionLabel(version.sequence),
      }),
    });
  }
  if (deck.working !== null) {
    compareItems.push({
      label: 'With current Moxfield deck',
      detail: isLatest ? 'Uncommitted changes since this version' : 'What changed since this version',
      href: routes.compare(deck.id, { from: versionLabel(version.sequence), to: 'working' }),
    });
  }
  if (deck.head !== null && !isLatest) {
    compareItems.push({
      label: `With latest version (${versionLabel(deck.head.sequence)})`,
      detail: deck.head.message,
      href: routes.compare(deck.id, {
        from: versionLabel(version.sequence),
        to: versionLabel(deck.head.sequence),
      }),
    });
  }

  if (compareItems.length === 0) {
    compareItems.push({
      label: 'With the empty deck',
      detail: 'Every card in this version',
      href: routes.compare(deck.id, { from: 'empty', to: versionLabel(version.sequence) }),
    });
  }

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <nav aria-label="Versions" className="flex items-center justify-between gap-2">
        <Link
          href={routes.history(deck.id)}
          className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-muted hover:text-fg md:min-h-9"
        >
          <History aria-hidden="true" className="size-4" />
          History
        </Link>
        <div className="flex items-center gap-1">
          <StepLink
            href={previous === null ? null : routes.version(deck.id, previous.sequence, tab)}
            label={previous === null ? 'Older' : versionLabel(previous.sequence)}
            direction="older"
          />
          <StepLink
            href={next === null ? null : routes.version(deck.id, next.sequence, tab)}
            label={next === null ? 'Newer' : versionLabel(next.sequence)}
            direction="newer"
          />
        </div>
      </nav>

      <header className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <VersionBadge sequence={version.sequence} latest={isLatest} />
          <h2 className="min-w-0 text-xl leading-snug font-semibold tracking-tight break-words text-fg">
            <span className="sr-only">{versionLabel(version.sequence)}: </span>
            {version.message}
          </h2>
        </div>
        <ul
          className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted"
          aria-label="About this version"
        >
          <li className="inline-flex items-center gap-1.5">
            <CalendarClock aria-hidden="true" className="size-4 shrink-0 text-subtle" />
            <span>
              <AbsoluteTime value={version.createdAt} className="text-fg/80" />{' '}
              <span className="whitespace-nowrap text-subtle">
                (<RelativeTime value={version.createdAt} style="words" />)
              </span>
            </span>
          </li>
          {version.sourceVersion !== null && (
            <li className="inline-flex items-center gap-1.5 whitespace-nowrap tabular">
              <Hash aria-hidden="true" className="size-4 text-subtle" />
              Moxfield version {version.sourceVersion}
            </li>
          )}
          {isLatest && (
            <li>
              <Badge tone="accent">Latest version</Badge>
            </li>
          )}
        </ul>
        <TagEditor
          deckId={deck.id}
          sequence={version.sequence}
          tags={version.tags}
          suggestions={tags.map((tag) => tag.name)}
        />
        <div className="flex flex-wrap gap-2">
          <ButtonLink
            href={routes.restore(deck.id, version.sequence)}
            variant="primary"
            icon={<Undo2 aria-hidden="true" className="size-4" />}
          >
            Restore to Moxfield
          </ButtonLink>
          <CompareMenu items={compareItems} />
        </div>
      </header>

      <div className="grid items-start gap-5 md:gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <SegmentedLinks
            label="Version content"
            activeId={tab}
            block
            className="md:w-auto md:max-w-md"
            items={[
              {
                id: 'changes',
                label: 'Changes',
                href: routes.version(deck.id, version.sequence),
                icon: <ListTree aria-hidden="true" className="size-4" />,
                count: initial ? undefined : diffChangeCount(diff),
              },
              {
                id: 'deck',
                label: 'Deck',
                href: routes.version(deck.id, version.sequence, 'deck'),
                icon: <LayoutList aria-hidden="true" className="size-4" />,
                count: playedCardCount(snapshot),
              },
              {
                id: 'primer',
                label: 'Primer',
                href: routes.version(deck.id, version.sequence, 'primer'),
                icon: <FileText aria-hidden="true" className="size-4" />,
              },
            ]}
          />

          {tab === 'changes' && (
            <Card
              as="section"
              aria-label={
                initial ? 'Initial version' : `Changes since ${versionLabel(version.parentSequence ?? 0)}`
              }
            >
              {initial ? (
                <div className="mb-4">
                  <h3 className="text-base font-semibold text-fg">Initial version</h3>
                  <p className="text-sm text-muted">
                    {pluralize(initialPlayedCount(diff), 'card')} in the deck
                  </p>
                </div>
              ) : (
                <div className="mb-4 flex flex-col gap-2">
                  <h3 className="text-base font-semibold text-fg">
                    Changes since {versionLabel(version.parentSequence ?? 0)}
                  </h3>
                  <SummaryChips diff={diff} />
                </div>
              )}
              <DiffView
                diff={diff}
                catalog={catalog}
                deckId={deck.id}
                initial={initial}
                primerHref={routes.version(deck.id, version.sequence, 'primer')}
                emptyMessage="This version is identical to the previous one."
              />
            </Card>
          )}

          {tab === 'deck' && (
            <Card as="section" aria-label="Deck list">
              <DeckList snapshot={snapshot} catalog={catalog} deckId={deck.id} />
            </Card>
          )}

          {tab === 'primer' && (
            <>
              {!initial && primerDiff.hunks.length > 0 && (
                <Card as="section" aria-labelledby="primer-changes" flush>
                  <Disclosure
                    variant="plain"
                    defaultOpen
                    className="px-4 py-1 md:px-5"
                    summary={
                      <span id="primer-changes" className="font-semibold">
                        Primer changes since {versionLabel(version.parentSequence ?? 0)}
                      </span>
                    }
                  >
                    <PrimerDiffView diff={primerDiff} />
                  </Disclosure>
                </Card>
              )}
              <Card as="section" aria-label="Primer">
                {snapshot.primer === null ? (
                  <EmptyNote>The primer was not captured for this version.</EmptyNote>
                ) : primerMarkdown === null ? (
                  <EmptyNote>This deck had no primer in this version.</EmptyNote>
                ) : (
                  <>
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border pb-3">
                      <p className="text-sm text-muted">
                        To put this primer back on Moxfield, copy its source and paste it into the primer
                        editor.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <CopyButton
                          text={snapshot.primer}
                          label="Copy primer"
                          subject="Primer"
                          variant="secondary"
                          size="sm"
                        />
                        <ButtonLink
                          href={routes.restore(deck.id, version.sequence, 'primer')}
                          variant="ghost"
                          size="sm"
                        >
                          Restore steps
                        </ButtonLink>
                      </div>
                    </div>
                    <PrimerView markdown={primerMarkdown} />
                  </>
                )}
              </Card>
            </>
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-5" aria-label="Notes and details">
          <Card as="section" aria-labelledby="notes-heading">
            <h3 id="notes-heading" className="mb-2 text-base font-semibold text-fg">
              Notes
            </h3>
            <NotesEditor
              deckId={deck.id}
              sequence={version.sequence}
              text={note === null ? '' : noteText(note.data)}
              updatedAt={note?.updatedAt ?? null}
            />
          </Card>
          <Card as="section" aria-labelledby="details-heading">
            <h3 id="details-heading" className="mb-3 text-base font-semibold text-fg">
              Details
            </h3>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-sm">
              <Detail term="Committed">
                <AbsoluteTime value={version.createdAt} />
              </Detail>
              {version.sourceUpdatedAt !== null && (
                <Detail term="Moxfield edit">
                  <AbsoluteTime value={version.sourceUpdatedAt} />
                </Detail>
              )}
              <Detail term="Captured">{describeIngestMethod(version.ingestMethod)}</Detail>
              <Detail term="Parent">
                {previous === null ? (
                  <span className="text-muted">None (first version)</span>
                ) : (
                  <Link
                    href={routes.version(deck.id, previous.sequence)}
                    className="font-medium text-accent hover:underline"
                  >
                    {versionLabel(previous.sequence)}
                  </Link>
                )}
              </Detail>
              <Detail term="Version id">
                <span className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
                    {version.shortId}
                  </code>
                  <CopyButton
                    text={version.commitId}
                    label="Copy id"
                    subject="Version id"
                    size="sm"
                    variant="ghost"
                  />
                </span>
              </Detail>
            </dl>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{term}</dt>
      <dd className="min-w-0 text-fg">{children}</dd>
    </>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

function StepLink({
  href,
  label,
  direction,
}: {
  href: ReturnType<typeof routes.version> | null;
  label: string;
  direction: 'older' | 'newer';
}) {
  const content = (
    <>
      {direction === 'older' && <ChevronLeft aria-hidden="true" className="size-4" />}
      <span className="tabular">{label}</span>
      {direction === 'newer' && <ChevronRight aria-hidden="true" className="size-4" />}
    </>
  );
  const className =
    'inline-flex min-h-11 items-center gap-0.5 rounded-lg px-2.5 text-sm font-medium md:min-h-9';
  if (href === null) {
    return (
      <span aria-disabled="true" className={`${className} text-subtle/60`}>
        {content}
      </span>
    );
  }
  return (
    <Link
      href={href}
      aria-label={`${direction === 'older' ? 'Previous' : 'Next'} version, ${label}`}
      className={`${className} text-muted hover:bg-surface-2 hover:text-fg`}
    >
      {content}
    </Link>
  );
}
