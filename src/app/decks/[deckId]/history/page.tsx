import clsx from 'clsx';
import { History, Tag } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { VersionTimeline } from '@/components/deck/version-timeline';
import { ButtonLink } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { pluralize } from '@/lib/format';
import { deckTitle } from '@/lib/presentation';
import { routes } from '@/lib/routes';
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

  if (overview.versionCount === 0) {
    return (
      <EmptyState
        icon={<History aria-hidden="true" />}
        title="No versions yet"
        description="Review the current Moxfield deck on the Status page and commit it as v1."
        actions={
          <ButtonLink href={routes.deck(overview.id)} variant="primary">
            Go to Status
          </ButtonLink>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-fg">History</h2>
          <p className="text-sm text-muted">
            {tag === undefined
              ? `${pluralize(overview.versionCount, 'version')}. Select two to compare them.`
              : `${pluralize(versions.length, 'version')} tagged “${tag}”`}
          </p>
        </div>
      </div>

      {tags.length > 0 && (
        <nav
          aria-label="Filter by tag"
          className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0"
        >
          <ul className="flex w-max gap-1.5 sm:w-auto sm:flex-wrap">
            <li>
              <FilterChip href={routes.history(overview.id)} active={tag === undefined}>
                All
              </FilterChip>
            </li>
            {tags.map((item) => (
              <li key={item.name}>
                <FilterChip href={routes.history(overview.id, { tag: item.name })} active={tag === item.name}>
                  <Tag aria-hidden="true" className="size-3.5" />
                  {item.name}
                  <span className="text-xs opacity-70 tabular">{item.count}</span>
                </FilterChip>
              </li>
            ))}
          </ul>
        </nav>
      )}

      {versions.length === 0 ? (
        <EmptyState
          icon={<Tag aria-hidden="true" />}
          title={`No versions tagged “${tag ?? ''}”`}
          actions={
            <ButtonLink href={routes.history(overview.id)} variant="secondary">
              Show all versions
            </ButtonLink>
          }
        />
      ) : (
        <VersionTimeline
          deckId={overview.id}
          versions={versions}
          headSequence={overview.head?.sequence ?? null}
          hasWorking={overview.working !== null}
          selectable
          framed
        />
      )}
    </div>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: ReturnType<typeof routes.history>;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      scroll={false}
      className={clsx(
        'inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium whitespace-nowrap transition-colors md:h-8',
        active
          ? 'border-accent bg-accent text-accent-fg'
          : 'border-border-strong bg-surface text-muted hover:border-subtle hover:text-fg',
      )}
    >
      {children}
    </Link>
  );
}
