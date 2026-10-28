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
import type { Route } from 'next';
import type { ReactNode } from 'react';

import { CompareMenu, type CompareMenuItem } from '@/components/deck/compare-menu';
import { DeckList } from '@/components/deck/deck-list';
import { changesTitle, DiffView, initialDescription } from '@/components/deck/diff-view';
import { PrimerDiffView } from '@/components/deck/primer-diff-view';
import { PrimerView } from '@/components/deck/primer-view';
import { SummaryChips } from '@/components/deck/summary-chips';
import { VersionBadge } from '@/components/deck/version-row';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { Disclosure } from '@/components/ui/disclosure';
import { Link } from '@/components/ui/navigation';
import { AbsoluteTime, RelativeTime } from '@/components/ui/relative-time';
import { SidebarLayout } from '@/components/ui/sidebar-layout';
import { SegmentedLinks } from '@/components/ui/tabs';
import { TextLink } from '@/components/ui/text-link';
import { playedCardCount } from '@/core/canonical';
import { diffChangeCount } from '@/core/diff';
import { versionLabel } from '@/lib/format';
import { describeIngestMethod } from '@/lib/presentation';
import { deckRoutes, type DeckRoutes, type DeckScope, type VersionTab } from '@/lib/routes';
import { EMPTY_REF, WORKING_REF } from '@/lib/version-refs';
import type { SharedVersionDetailDTO } from '@/server/services/types';

export interface VersionContentProps {
  scope: DeckScope;
  /** The version (an owner's `VersionDetailDTO` fits too: its deck has every field used here). */
  detail: SharedVersionDetailDTO;
  tab: VersionTab;
  /** Whether the deck has a current Moxfield state to compare with (owners only). */
  hasWorking: boolean;
  /** The version's tags: the owner's editor, or a read-only list for viewers. */
  tags: ReactNode;
  /**
   * The content of the Notes card: the owner's editor, or the notes for viewers of a link
   * that includes them. Without it there is no Notes card.
   */
  notes?: ReactNode;
}

/** The parsed `?tab=` of a version page. */
export function parseVersionTab(value: string | string[] | undefined): VersionTab {
  return value === 'deck' || value === 'primer' ? value : 'changes';
}

/** One version of a deck: what changed, the full deck, the primer, tags, notes and details. */
export function VersionContent({ scope, detail, tab, hasWorking, tags, notes }: VersionContentProps) {
  const { deck, version, snapshot, primerMarkdown, diff, primerDiff, catalog, previous, next } = detail;
  const routes = deckRoutes(scope);
  const isLatest = deck.head?.sequence === version.sequence;
  const initial = version.parentSequence === null;

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <nav aria-label="Versions" className="flex items-center justify-between gap-2">
        <BackLink href={routes.history()} icon={<History aria-hidden="true" className="size-4" />}>
          History
        </BackLink>
        <div className="flex items-center gap-1">
          <StepLink
            href={previous === null ? null : routes.version(previous.sequence, tab)}
            label={previous === null ? 'Older' : versionLabel(previous.sequence)}
            direction="older"
          />
          <StepLink
            href={next === null ? null : routes.version(next.sequence, tab)}
            label={next === null ? 'Newer' : versionLabel(next.sequence)}
            direction="newer"
          />
        </div>
      </nav>

      <header className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <VersionBadge sequence={version.sequence} latest={isLatest} />
          <div className="flex min-w-0 flex-col gap-2">
            <h2 className="min-w-0 text-xl leading-snug font-semibold tracking-tight break-words text-fg">
              <span className="sr-only">{versionLabel(version.sequence)}: </span>
              {version.message}
            </h2>
            {version.description !== '' && (
              <p
                aria-label="Description"
                className="max-w-prose text-sm leading-relaxed break-words whitespace-pre-wrap text-fg/80"
              >
                {version.description}
              </p>
            )}
          </div>
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
        {tags}
        <div className="flex flex-wrap gap-2">
          <ButtonLink
            href={routes.restore(version.sequence)}
            variant="primary"
            icon={<Undo2 aria-hidden="true" className="size-4" />}
          >
            Restore to Moxfield
          </ButtonLink>
          <CompareMenu items={compareItems(routes, detail, hasWorking)} />
        </div>
      </header>

      <SidebarLayout>
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
                href: routes.version(version.sequence),
                icon: <ListTree aria-hidden="true" className="size-4" />,
                count: initial ? undefined : diffChangeCount(diff),
              },
              {
                id: 'deck',
                label: 'Deck',
                href: routes.version(version.sequence, 'deck'),
                icon: <LayoutList aria-hidden="true" className="size-4" />,
                count: playedCardCount(snapshot),
              },
              {
                id: 'primer',
                label: 'Primer',
                href: routes.version(version.sequence, 'primer'),
                icon: <FileText aria-hidden="true" className="size-4" />,
              },
            ]}
          />

          {tab === 'changes' && (
            <Card as="section" aria-label={changesTitle(version.parentSequence)}>
              {initial ? (
                <div className="mb-4">
                  <h3 className="text-base font-semibold text-fg">{changesTitle(null)}</h3>
                  <p className="text-sm text-muted">{initialDescription(playedCardCount(snapshot))}</p>
                </div>
              ) : (
                <div className="mb-4 flex flex-col gap-2">
                  <h3 className="text-base font-semibold text-fg">{changesTitle(version.parentSequence)}</h3>
                  <SummaryChips diff={diff} view={detail.view} />
                </div>
              )}
              <DiffView
                diff={diff}
                catalog={catalog}
                scope={scope}
                initial={initial}
                primerHref={routes.version(version.sequence, 'primer')}
                emptyMessage="This version is identical to the previous one."
                view={detail.view}
                hiddenChangeCount={detail.hiddenChangeCount}
              />
            </Card>
          )}

          {tab === 'deck' && (
            <Card as="section" aria-label="Deck list">
              <DeckList snapshot={snapshot} catalog={catalog} scope={scope} />
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
                          href={routes.restore(version.sequence, 'primer')}
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
          {notes !== undefined && (
            <Card as="section" aria-labelledby="notes-heading">
              <h3 id="notes-heading" className="mb-2 text-base font-semibold text-fg">
                Notes
              </h3>
              {notes}
            </Card>
          )}
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
                  <TextLink href={routes.version(previous.sequence)}>
                    {versionLabel(previous.sequence)}
                  </TextLink>
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
      </SidebarLayout>
    </div>
  );
}

/**
 * The version page's comparisons: with the previous version, the current Moxfield deck
 * (owners only) and the latest version; the empty deck when there is nothing else.
 */
function compareItems(
  routes: DeckRoutes,
  { deck, version, previous }: SharedVersionDetailDTO,
  hasWorking: boolean,
): CompareMenuItem[] {
  const isLatest = deck.head?.sequence === version.sequence;
  const items: CompareMenuItem[] = [];
  if (previous !== null) {
    items.push({
      label: `With previous (${versionLabel(previous.sequence)})`,
      detail: previous.message,
      href: routes.compare({ from: versionLabel(previous.sequence), to: versionLabel(version.sequence) }),
    });
  }
  if (hasWorking) {
    items.push({
      label: 'With current Moxfield deck',
      detail: isLatest ? 'Uncommitted changes since this version' : 'What changed since this version',
      href: routes.compare({ from: versionLabel(version.sequence), to: WORKING_REF }),
    });
  }
  if (deck.head !== null && !isLatest) {
    items.push({
      label: `With latest version (${versionLabel(deck.head.sequence)})`,
      detail: deck.head.message,
      href: routes.compare({ from: versionLabel(version.sequence), to: versionLabel(deck.head.sequence) }),
    });
  }
  if (items.length === 0) {
    items.push({
      label: 'With the empty deck',
      detail: 'Every card in this version',
      href: routes.compare({ from: EMPTY_REF, to: versionLabel(version.sequence) }),
    });
  }
  return items;
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
  href: Route | null;
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
