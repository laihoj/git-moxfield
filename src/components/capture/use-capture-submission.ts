'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { routes } from '@/lib/routes';

import { postCapture, type CaptureMethod, type CaptureResponse } from './capture-api';

export type SubmissionPhase =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  /** The deck is not tracked; the user must confirm before it is. */
  | { kind: 'untracked'; name: string; externalId: string }
  | { kind: 'tracking'; name: string }
  | { kind: 'done'; deckId: string; changed: boolean }
  | { kind: 'failed'; message: string };

export interface CaptureSubmission {
  phase: SubmissionPhase;
  /** Sends a capture without tracking unknown decks. Resolves with the server's answer. */
  submit: (payload: unknown, method: CaptureMethod) => Promise<CaptureResponse>;
  /** Confirms tracking the untracked deck from the last submission and sends it again. */
  track: () => Promise<void>;
  reset: () => void;
}

/**
 * Submission flow shared by the bookmarklet receiver and the paste form: submit
 * (`track: false`), ask before tracking an unknown deck, then open the deck page. The
 * payload is kept in a ref, never in rendered state, because it can be megabytes.
 */
export function useCaptureSubmission(): CaptureSubmission {
  const router = useRouter();
  const [phase, setPhase] = useState<SubmissionPhase>({ kind: 'idle' });
  const last = useRef<{ payload: unknown; method: CaptureMethod } | null>(null);

  function apply(result: CaptureResponse): void {
    if (!result.ok) {
      setPhase({ kind: 'failed', message: result.message });
      return;
    }
    const { outcome } = result;
    if (outcome.status === 'untracked') {
      setPhase({ kind: 'untracked', name: outcome.name, externalId: outcome.externalId });
      return;
    }
    last.current = null;
    setPhase({ kind: 'done', deckId: outcome.deckId, changed: outcome.changedSinceLastObservation });
    router.replace(routes.deck(outcome.deckId, { captured: true }));
  }

  async function submit(payload: unknown, method: CaptureMethod): Promise<CaptureResponse> {
    last.current = { payload, method };
    setPhase({ kind: 'submitting' });
    const result = await postCapture(payload, method, false);
    apply(result);
    return result;
  }

  async function track(): Promise<void> {
    const pending = last.current;
    if (pending === null || phase.kind !== 'untracked') return;
    setPhase({ kind: 'tracking', name: phase.name });
    apply(await postCapture(pending.payload, pending.method, true));
  }

  function reset(): void {
    last.current = null;
    setPhase({ kind: 'idle' });
  }

  return { phase, submit, track, reset };
}
