'use client';

import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

import type { SubmissionPhase } from './use-capture-submission';

export interface CaptureStatusProps {
  phase: SubmissionPhase;
  onTrack: () => void;
  onCancel: () => void;
}

/**
 * Progress and outcome of a capture: importing, "Track this deck?" confirmation,
 * success ("Updated from Moxfield", then the deck page opens) and failures.
 */
export function CaptureStatus({ phase, onTrack, onCancel }: CaptureStatusProps) {
  switch (phase.kind) {
    case 'idle':
      return null;
    case 'submitting':
      return <Progress text="Importing the deck…" />;
    case 'tracking':
      return <Progress text={`Tracking “${phase.name}”…`} />;
    case 'untracked':
      return (
        <section
          aria-labelledby="track-confirm"
          className="flex flex-col gap-3 rounded-lg border border-accent/30 bg-accent-soft/50 p-4"
        >
          <h2 id="track-confirm" className="text-base font-semibold break-words text-fg">
            Track “{phase.name}”?
          </h2>
          <p className="text-sm text-muted">
            git-moxfield does not track this deck yet. Track it to keep its versions here. Nothing is written
            to Moxfield.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={<Plus aria-hidden="true" className="size-4" />} onClick={onTrack}>
              Track this deck
            </Button>
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </section>
      );
    case 'done':
      return (
        <Alert tone="success" role="status" title="Updated from Moxfield">
          {phase.changed
            ? 'The deck has new changes since the last update.'
            : 'No changes since the last update.'}{' '}
          Opening the deck…
        </Alert>
      );
    case 'failed':
      return (
        <Alert tone="error" role="alert" title="The deck could not be imported">
          <span className="break-words">{phase.message}</span>
        </Alert>
      );
  }
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
