'use client';

import { ArrowUpRight, Download } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/field';
import {
  MOXFIELD_DECK_PATH_PREFIX,
  MOXFIELD_PRIMER_PATH_PREFIX,
  MOXFIELD_PRIMER_PATH_SUFFIX,
  moxfieldDeckApiPath,
  moxfieldPrimerApiPath,
} from '@/integrations/moxfield/constants';
import type { CaptureFormError } from '@/integrations/moxfield/capture-protocol';
import { parseMoxfieldDeckInput } from '@/integrations/moxfield/url';

import { CaptureStatus } from './capture-status';
import { PasteZone, type PastedContent } from './paste-zone';
import { useCaptureSubmission } from './use-capture-submission';

export interface PasteCaptureProps {
  /** Moxfield API base URL (`https://api2.moxfield.com`), for the data links. */
  apiBaseUrl: string;
  /** Moxfield site origin, to recognize pasted deck URLs. */
  siteOrigin: string;
  /** A notice above the form (e.g. why the bookmarklet flow fell back to pasting). */
  notice?: ReactNode;
}

/**
 * Firefox opens JSON in its viewer's tree view, where select-all copies the tree's text,
 * not the JSON; the viewer's own Copy button (or saving the file) gives the real JSON.
 */
const FIREFOX_COPY_HINT = "In Firefox, use the page's Copy button (or Save it and choose the file).";

function notJson(page: 'deck' | 'primer'): string {
  return `This is not valid JSON. Copy the whole ${page} data page: select all, then copy. ${FIREFOX_COPY_HINT}`;
}

function deckProblem(value: PastedContent | null): string | null {
  if (value === null) return null;
  switch (value.kind) {
    case 'invalid':
      return notJson('deck');
    case 'primer':
      return 'This is the primer JSON. Paste it in the primer field below; the deck JSON goes here.';
    case 'unknown':
      return 'This JSON does not look like a Moxfield deck.';
    default:
      return null;
  }
}

function primerProblem(value: PastedContent | null): string | null {
  if (value === null) return null;
  if (value.kind === 'invalid') return notJson('primer');
  if (value.kind === 'deck' || value.kind === 'envelope' || value.kind === 'wrapper')
    return 'This is the deck JSON; paste it in the field above.';
  return null;
}

/**
 * Manual import: open Moxfield's deck data URL in the browser, copy, paste here (and
 * optionally the primer). Large JSON is held in memory, never rendered, and sent
 * compressed. A bookmarklet's capture (copied when its popup was blocked) can be pasted
 * here too.
 */
export function PasteCapture({ apiBaseUrl, siteOrigin, notice }: PasteCaptureProps) {
  const urlId = useId();
  const [deckInput, setDeckInput] = useState('');
  const [deck, setDeck] = useState<PastedContent | null>(null);
  const [primer, setPrimer] = useState<PastedContent | null>(null);
  const submission = useCaptureSubmission();

  const typed = parseMoxfieldDeckInput(deckInput, siteOrigin);
  const publicId = (typed.ok ? typed.ref.externalId : null) ?? deck?.publicId ?? null;
  const deckDataUrl =
    apiBaseUrl +
    (publicId === null ? `${MOXFIELD_DECK_PATH_PREFIX}<deck id>` : moxfieldDeckApiPath(publicId));
  const internalId = deck?.internalId;
  const primerDataUrl = internalId === undefined ? null : apiBaseUrl + moxfieldPrimerApiPath(internalId);
  // A bookmarklet capture or a { deck, primer } pair already holds everything: no primer step.
  const isComplete = deck?.kind === 'envelope' || deck?.kind === 'wrapper';
  const deckError = deckProblem(deck);
  const primerError = primerProblem(primer);
  const busy =
    submission.phase.kind === 'submitting' ||
    submission.phase.kind === 'tracking' ||
    submission.phase.kind === 'relinking';
  const canSubmit = deck !== null && deckError === null && primerError === null && !busy;

  function importDeck(): void {
    if (deck === null) return;
    // One JSON text either way, which the submission compresses: the deck (or capture)
    // alone, or deck and primer as JSON strings in `{ deck, primer }`.
    const text =
      primer === null || isComplete ? deck.text : JSON.stringify({ deck: deck.text, primer: primer.text });
    void submission.submit(text, deck.kind === 'envelope' ? 'browser-capture' : 'manual-paste');
  }

  return (
    <div className="flex flex-col gap-5">
      {notice}
      <Card as="section" aria-labelledby="paste-steps" className="flex flex-col gap-5">
        <h2 id="paste-steps" className="sr-only">
          Paste steps
        </h2>
        <Step number={1} title="Which deck?">
          <label htmlFor={urlId} className="sr-only">
            Moxfield deck URL
          </label>
          <Input
            id={urlId}
            value={deckInput}
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={`${siteOrigin}/decks/…`}
            onChange={(event) => {
              setDeckInput(event.target.value);
            }}
          />
          {deckInput.trim() !== '' && publicId === null && (
            <p className="text-sm text-remove">That does not look like a Moxfield deck URL.</p>
          )}
        </Step>

        <Step number={2} title="Open the deck data and copy all of it">
          <DataLink href={publicId === null ? null : deckDataUrl} label={deckDataUrl} />
          <p className="text-xs text-pretty text-muted">
            The page shows the deck as JSON. Select all (<span className="font-medium">Ctrl/⌘ + A</span>) and
            copy. A copied bookmarklet capture works here too.
          </p>
          <p className="text-xs text-pretty text-muted">
            In Firefox, use the page&apos;s <span className="font-medium">Copy</span> button instead: select
            all copies its tree view, not the JSON. Or click <span className="font-medium">Save</span> and use{' '}
            <span className="font-medium">Choose file</span> below.
          </p>
        </Step>

        <Step number={3} title="Paste it here">
          <PasteZone
            label="Deck JSON"
            description="Paste the deck JSON here"
            value={deck}
            onChange={(value) => {
              setDeck(value);
              submission.reset();
            }}
            problem={deckError}
          />
        </Step>

        {!isComplete && (
          <Step number={4} title="Optional: the primer">
            <DataLink
              href={primerDataUrl}
              label={
                primerDataUrl ??
                `${apiBaseUrl}${MOXFIELD_PRIMER_PATH_PREFIX}<internal id>${MOXFIELD_PRIMER_PATH_SUFFIX}`
              }
              disabledHint="The link appears once the deck JSON is pasted (it needs the deck's internal id)."
            />
            <PasteZone
              label="Primer JSON (optional)"
              description="Paste the primer JSON here"
              value={primer}
              onChange={(value) => {
                setPrimer(value);
                submission.reset();
              }}
              problem={primerError}
            />
          </Step>
        )}

        <CaptureStatus submission={submission} />

        {submission.phase.kind !== 'untracked' && submission.phase.kind !== 'done' && (
          <Button
            variant="primary"
            size="lg"
            block
            disabled={!canSubmit}
            loading={busy}
            icon={<Download aria-hidden="true" className="size-5" />}
            onClick={importDeck}
          >
            Import deck
          </Button>
        )}
      </Card>
    </div>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <section className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 gap-y-2">
      <span
        aria-hidden="true"
        className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent tabular"
      >
        {number}
      </span>
      <h3 className="self-center text-sm font-semibold text-fg">
        <span className="sr-only">Step {number}: </span>
        {title}
      </h3>
      <div className="col-start-2 flex min-w-0 flex-col gap-2">{children}</div>
    </section>
  );
}

function DataLink({
  href,
  label,
  disabledHint,
}: {
  href: string | null;
  label: string;
  disabledHint?: string;
}) {
  if (href === null) {
    return (
      <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
        <span className="font-mono break-all">{label}</span>
        {disabledHint !== undefined && <span className="mt-1 block">{disabledHint}</span>}
      </p>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex min-h-11 items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-xs break-all text-accent hover:border-accent/50"
    >
      <span className="min-w-0 flex-1">{label}</span>
      <ArrowUpRight aria-hidden="true" className="size-4 shrink-0" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

const FORM_ERROR_TITLES: Record<CaptureFormError, string> = {
  'too-large': 'The deck sent from Moxfield was too large to import.',
  invalid: 'The deck sent from Moxfield could not be read.',
  failed: 'Importing the deck sent from Moxfield failed.',
};

/** Notice for `?error=` codes set by the same-tab capture endpoint. */
export function FormErrorNotice({ code }: { code: CaptureFormError }) {
  return (
    <Alert tone="error" title={FORM_ERROR_TITLES[code]}>
      You can paste the deck below instead.
    </Alert>
  );
}
