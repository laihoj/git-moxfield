import clsx from 'clsx';
import { ArrowUpRight, Download, Eraser, Eye, Hand, Info } from 'lucide-react';

import { isKnownZone, type ZoneId } from '@/core/zones';
import type { RestoreExport, RestorePrimer, RestoreSection } from '@/integrations/deck-source';
import { Badge } from '@/components/ui/badge';
import { buttonClasses, ExternalButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { Disclosure } from '@/components/ui/disclosure';
import { pluralize } from '@/lib/format';

import { zoneTextClass } from './zone-badge';

export interface RestorePanelProps {
  restore: RestoreExport;
  /**
   * The deck on Moxfield to restore into, for its owner. Without it (a share link viewer,
   * who restores into a deck of their own) there is no link to a deck.
   */
  deckUrl?: string;
  /** URL of the plain-text download of every section. */
  downloadHref: string;
}

function lineCount(text: string): number {
  return text.split('\n').filter((line) => line.trim() !== '').length;
}

/** Rows for a read-only text block: tall enough to show its shape, capped so the page stays scannable. */
function rowsFor(text: string, minRows: number): number {
  return Math.min(12, Math.max(minRows, lineCount(text)));
}

/**
 * Restore a version to Moxfield by copy and paste (git-moxfield never writes to
 * Moxfield): numbered steps, one copy block per Bulk Edit board, the combined list
 * for creating a new deck, and the limitations of restoring via text.
 */
export function RestorePanel({ restore, deckUrl, downloadHref }: RestorePanelProps) {
  return (
    <div className="flex flex-col gap-6">
      <Card as="section" aria-labelledby="restore-steps">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 id="restore-steps" className="text-base font-semibold text-fg">
            Steps
          </h2>
          <div className="flex flex-wrap gap-2">
            {deckUrl !== undefined && (
              <ExternalButtonLink
                href={deckUrl}
                size="sm"
                variant="primary"
                trailingIcon={<ArrowUpRight aria-hidden="true" className="size-4" />}
              >
                Open deck in Moxfield
              </ExternalButtonLink>
            )}
            <a href={downloadHref} download className={buttonClasses({ size: 'sm', variant: 'secondary' })}>
              <Download aria-hidden="true" className="size-4" />
              Download .txt
            </a>
          </div>
        </div>
        <ol className="flex flex-col gap-2.5">
          {restore.instructions.map((step, index) => (
            <li key={index} className="flex gap-3 text-sm leading-6 text-fg">
              <span
                aria-hidden="true"
                className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent tabular select-none"
              >
                {index + 1}
              </span>
              <span className="min-w-0 break-words">{step}</span>
            </li>
          ))}
        </ol>
      </Card>

      <section aria-labelledby="restore-sections" className="flex flex-col gap-3">
        <h2 id="restore-sections" className="text-base font-semibold text-fg">
          Paste blocks
        </h2>
        {restore.sections.map((section) => (
          <SectionBlock key={section.zone} section={section} />
        ))}
        {restore.primer !== null && <PrimerBlock primer={restore.primer} />}
      </section>

      {restore.combined !== null && (
        <Disclosure summary="Create a new deck instead" variant="card" meta="One combined list">
          <p className="mb-3 text-sm text-muted">{restore.combined.note}</p>
          <TextBlock id="restore-combined" label="Combined list" text={restore.combined.text} />
          <p className="mt-1 text-right text-xs text-muted tabular">
            {pluralize(lineCount(restore.combined.text), 'line')}
          </p>
          <div className="mt-3">
            <CopyButton
              text={restore.combined.text}
              label="Copy combined list"
              subject="Combined list"
              variant="primary"
              size="lg"
              block
            />
          </div>
        </Disclosure>
      )}

      {restore.limitations.length > 0 && (
        <section
          aria-labelledby="restore-limitations"
          className="rounded-xl border border-border bg-surface-2/60 p-4 md:p-5"
        >
          <h2 id="restore-limitations" className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Info aria-hidden="true" className="size-4 text-muted" />
            Limitations of restoring by text
          </h2>
          <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted marker:text-subtle">
            {restore.limitations.map((limitation, index) => (
              <li key={index} className="break-words">
                {limitation}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * How a section is restored. Only Bulk Edit boards are pasted (the primary action of
 * the page); the command zone is set with deck-page actions on Moxfield, and boards
 * without a Bulk Edit tab (tokens, boards git-moxfield does not know) are listed for
 * reference only.
 */
type SectionKind = 'paste' | 'manual' | 'reference';

const MANUAL_ZONES: ReadonlySet<ZoneId> = new Set<ZoneId>(['commanders', 'companions', 'signatureSpells']);

function sectionKind(zone: ZoneId): SectionKind {
  if (MANUAL_ZONES.has(zone)) return 'manual';
  if (zone === 'tokens' || !isKnownZone(zone)) return 'reference';
  return 'paste';
}

const KIND_NOTES: Record<Exclude<SectionKind, 'paste'>, { badge: string; note: string }> = {
  manual: {
    badge: 'Manual step',
    note: 'Bulk Edit does not change this. Set it by hand on Moxfield with the action above.',
  },
  reference: {
    badge: 'Reference only',
    note: 'Moxfield cannot restore this by pasting. The list is here for reference.',
  },
};

function SectionBlock({ section }: { section: RestoreSection }) {
  const id = `restore-${section.zone.replace(/[^a-z0-9-]/gi, '-')}`;
  const empty = section.cardCount === 0;
  const kind = sectionKind(section.zone);
  const lines = lineCount(section.text);
  return (
    <Card
      as="article"
      aria-labelledby={`${id}-label`}
      className={clsx('flex flex-col gap-3', kind !== 'paste' && 'bg-surface-2/40 shadow-none')}
    >
      <div className="flex flex-col gap-0.5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              id={`${id}-label`}
              className={clsx('text-sm font-semibold tracking-wide uppercase', zoneTextClass(section.zone))}
            >
              {section.label}
            </h3>
            {kind !== 'paste' && (
              <Badge
                tone="outline"
                icon={
                  kind === 'manual' ? (
                    <Hand aria-hidden="true" className="size-3" />
                  ) : (
                    <Eye aria-hidden="true" className="size-3" />
                  )
                }
              >
                {KIND_NOTES[kind].badge}
              </Badge>
            )}
          </div>
          <span className="text-sm text-muted tabular">{pluralize(section.cardCount, 'card')}</span>
        </div>
        <p className="text-sm break-words text-muted">{section.target}</p>
      </div>
      {kind !== 'paste' && <p className="-mt-1 text-sm text-fg/85">{KIND_NOTES[kind].note}</p>}
      {empty ? (
        <p className="flex items-center gap-2 rounded-lg border border-dashed border-border-strong px-3 py-3 text-sm text-fg">
          <Eraser aria-hidden="true" className="size-4 shrink-0 text-muted" />
          Clear this tab in Moxfield: this version has no {section.label} cards.
        </p>
      ) : kind === 'paste' ? (
        <div className="flex flex-col gap-1">
          <TextBlock id={id} label={`${section.label} restore text`} text={section.text} />
          <p className="text-right text-xs text-muted tabular">{pluralize(lines, 'line')}</p>
          <CopyButton
            text={section.text}
            label={`Copy ${section.label}`}
            subject={section.label}
            variant="primary"
            size="lg"
            block
            className="mt-2"
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <TextBlock id={id} label={`${section.label} restore text`} text={section.text} minRows={1} />
          <div className="flex items-center justify-between gap-3">
            <CopyButton
              text={section.text}
              label={`Copy ${section.label}`}
              subject={section.label}
              variant="secondary"
              size="sm"
            />
            <span className="text-xs text-muted tabular">{pluralize(lines, 'line')}</span>
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * The version's primer as Moxfield markup. Pasted into Moxfield's primer editor it
 * reproduces the primer exactly, directives and card links included. `id` makes it
 * linkable (`…/restore#restore-primer`) from the compare and version pages.
 */
function PrimerBlock({ primer }: { primer: RestorePrimer }) {
  const lines = lineCount(primer.text);
  return (
    <Card
      as="article"
      id="restore-primer"
      aria-labelledby="restore-primer-label"
      className="flex scroll-mt-4 flex-col gap-3"
    >
      <div className="flex flex-col gap-0.5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h3 id="restore-primer-label" className="text-sm font-semibold tracking-wide text-fg uppercase">
            Primer
          </h3>
          {primer.text !== '' && (
            <span className="text-sm text-muted tabular">{pluralize(lines, 'line')}</span>
          )}
        </div>
        <p className="text-sm break-words text-muted">{primer.target}</p>
      </div>
      {primer.text === '' ? (
        <p className="flex items-center gap-2 rounded-lg border border-dashed border-border-strong px-3 py-3 text-sm text-fg">
          <Eraser aria-hidden="true" className="size-4 shrink-0 text-muted" />
          Clear the primer in Moxfield if it has one: this version has no primer.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          <TextBlock id="restore-primer-text" label="Primer source" text={primer.text} />
          <p className="text-xs text-muted">
            Moxfield markup, exactly as captured. Paste it into the primer editor as is.
          </p>
          <CopyButton
            text={primer.text}
            label="Copy primer"
            subject="Primer"
            variant="primary"
            size="lg"
            block
            className="mt-2"
          />
        </div>
      )}
    </Card>
  );
}

function TextBlock({
  id,
  label,
  text,
  minRows = 3,
}: {
  id: string;
  label: string;
  text: string;
  /** Short blocks (a manual step's one or two cards) can be shorter than paste blocks. */
  minRows?: number;
}) {
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        id={id}
        readOnly
        value={text}
        rows={rowsFor(text, minRows)}
        spellCheck={false}
        className="block w-full resize-y rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-[0.8125rem] leading-5 text-fg focus:border-accent focus:ring-3 focus:ring-accent/20 focus:outline-none"
      />
    </>
  );
}
