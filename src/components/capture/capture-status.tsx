'use client';

import { History, Plus } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button, ButtonLink, type ButtonVariant } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { foldInlineText } from '@/core/text';
import { pluralize } from '@/lib/format';
import { routes } from '@/lib/routes';
import type { RelinkCandidateDTO } from '@/server/services/types';

import type { CaptureSubmission } from './use-capture-submission';

export interface CaptureStatusProps {
  submission: Pick<CaptureSubmission, 'phase' | 'track' | 'relink' | 'reset'>;
  /** Called by Cancel (of the tracking question); by default the submission is reset. */
  onCancel?: () => void;
}

/**
 * Progress and outcome of a capture: importing, "Track this deck?" confirmation (or
 * continuing one of the user's decks with it instead), success ("Updated from Moxfield",
 * then the deck page opens) and failures.
 */
export function CaptureStatus({ submission, onCancel = submission.reset }: CaptureStatusProps) {
  const { phase } = submission;
  const onTrack = (): void => {
    void submission.track();
  };
  const onRelink = (deckId: string): void => {
    void submission.relink(deckId);
  };
  switch (phase.kind) {
    case 'idle':
      return null;
    case 'submitting':
      return <Progress text="Importing the deck…" />;
    case 'tracking':
      return <Progress text={`Tracking “${phase.name}”…`} />;
    case 'relinking':
      return <Progress text={`Continuing “${phase.deckName}”…`} />;
    case 'untracked':
      return (
        <div className="flex flex-col gap-3">
          <section
            aria-labelledby="track-confirm"
            className="flex flex-col gap-3 rounded-lg border border-accent/30 bg-accent-soft/50 p-4"
          >
            <h2 id="track-confirm" className="text-base font-semibold break-words text-fg">
              Track “{phase.name}”?
            </h2>
            <p className="text-sm text-muted">
              git-moxfield does not track this deck yet. Track it to keep its versions here. Nothing is
              written to Moxfield.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                icon={<Plus aria-hidden="true" className="size-4" />}
                onClick={onTrack}
              >
                Track this deck
              </Button>
              <Button variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </section>
          {phase.decks.length > 0 && (
            <ContinueDeck capturedName={phase.name} decks={phase.decks} onRelink={onRelink} />
          )}
        </div>
      );
    case 'done':
      return (
        <Alert tone="success" role="status" title="Updated from Moxfield">
          {phase.relinked
            ? 'The deck now continues from this Moxfield deck.'
            : phase.changed
              ? 'The deck has new changes since the last update.'
              : 'No changes since the last update.'}{' '}
          Opening the deck…
        </Alert>
      );
    case 'failed':
      return (
        <Alert
          tone="error"
          role="alert"
          title={
            phase.code === 'invalid-key'
              ? 'This bookmarklet no longer works'
              : phase.code === 'unauthenticated'
                ? 'You’re signed out'
                : 'The deck could not be imported'
          }
          actions={
            phase.code === 'invalid-key' ? (
              <CaptureRemedyAction remedy="new-bookmarklet" />
            ) : phase.code === 'unauthenticated' ? (
              <CaptureRemedyAction remedy="sign-in" />
            ) : undefined
          }
        >
          <span className="break-words">{phase.message}</span>
        </Alert>
      );
  }
}

/**
 * "Continue an existing deck's history": for a deck deleted on Moxfield and made again,
 * whose new copy has a new public id and so arrives as an untracked deck. The user picks
 * the deck it replaces (preselected when exactly one has the captured deck's name).
 */
function ContinueDeck({
  capturedName,
  decks,
  onRelink,
}: {
  capturedName: string;
  decks: readonly RelinkCandidateDTO[];
  onRelink: (deckId: string) => void;
}) {
  const id = useId();
  const [selected, setSelected] = useState(() => {
    const wanted = foldInlineText(capturedName);
    const sameName = decks.filter((deck) => wanted !== '' && foldInlineText(deck.name) === wanted);
    return sameName.length === 1 ? (sameName[0]?.id ?? '') : '';
  });
  const deck = decks.find((candidate) => candidate.id === selected);

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-2/60 p-4"
    >
      <h2 id={`${id}-heading`} className="flex items-start gap-2 text-base font-semibold text-fg">
        <History aria-hidden="true" className="mt-1 size-4 shrink-0 text-muted" />
        Or continue an existing deck’s history
      </h2>
      <p className="text-sm text-pretty text-muted">
        Deleted a deck on Moxfield and made it again? The new copy has a new link, so it looks new here.
        Choose the deck it replaces: that deck then follows this Moxfield deck, keeps all its versions and
        shows what changed since its latest version.
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          Deck to continue
        </label>
        <Select
          id={id}
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
          }}
        >
          <option value="" disabled>
            Choose one of your decks…
          </option>
          {decks.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name} · {pluralize(candidate.versionCount, 'version')}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Button
          variant="secondary"
          disabled={deck === undefined}
          onClick={() => {
            if (deck !== undefined) onRelink(deck.id);
          }}
        >
          {deck === undefined ? 'Continue the chosen deck' : `Continue “${deck.name}”`}
        </Button>
      </div>
    </section>
  );
}

function Progress({ text }: { text: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-sm font-medium text-fg">
      <Spinner />
      {text}
    </p>
  );
}

/** Large centered state used while waiting for the bookmarklet's Moxfield tab. */
export function WaitingPanel({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center" role="status">
      <span className="flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
        <Spinner className="size-5" />
      </span>
      <p className="text-base font-semibold text-fg">{title}</p>
      {children !== undefined && <div className="max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}

/** An Alert action out of a refused capture: a new bookmarklet, or signing in (back to the paste page). */
export function CaptureRemedyAction({
  remedy,
  variant = 'secondary',
}: {
  remedy: 'new-bookmarklet' | 'sign-in';
  variant?: ButtonVariant;
}) {
  return remedy === 'new-bookmarklet' ? (
    <ButtonLink href={routes.setup()} variant={variant} size="sm">
      Make a new bookmarklet
    </ButtonLink>
  ) : (
    <ButtonLink href={routes.signIn(routes.capturePaste())} variant={variant} size="sm">
      Sign in
    </ButtonLink>
  );
}
