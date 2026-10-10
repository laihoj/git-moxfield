'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import type { CaptureRequestBody } from '@/integrations/moxfield/capture-protocol';
import { routes } from '@/lib/routes';

import {
  postCapture,
  type CaptureFailureCode,
  type CaptureMethod,
  type CaptureResponse,
} from './capture-api';

export type SubmissionPhase =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  /** The deck is not tracked; the user must confirm before it is. */
  | { kind: 'untracked'; name: string; externalId: string }
  | { kind: 'tracking'; name: string }
  | { kind: 'done'; deckId: string; changed: boolean }
  | { kind: 'failed'; message: string; code?: CaptureFailureCode };

export interface CaptureSubmission {
  phase: SubmissionPhase;
  /**
   * Sends a capture without tracking unknown decks. Resolves with the server's answer.
   * `key` is the bookmarklet key that came with a bookmarklet's deck (see `postCapture`).
   */
  submit: (
    payload: CaptureRequestBody['payload'],
    method: CaptureMethod,
    key?: string,
  ) => Promise<CaptureResponse>;
  /** Confirms tracking the untracked deck from the last submission and sends it again. */
  track: () => Promise<void>;
  reset: () => void;
}

interface PendingCapture {
  payload: CaptureRequestBody['payload'];
  method: CaptureMethod;
  key: string | undefined;
}

/**
 * Submission flow shared by the bookmarklet receiver and the paste form: submit
 * (`track: false`), ask before tracking an unknown deck, then open the deck page. The
 * payload (and a bookmarklet key) is kept in a ref, never in rendered state: the payload
 * can be megabytes, and the key is a secret.
 *
 * A capture sent with a key has signed this browser in (possibly as another user than
 * the page was rendered for), so the deck page is then opened with a full page load:
 * every part of the page, the header's user menu included, renders for the new session.
 */
export function useCaptureSubmission(): CaptureSubmission {
  const router = useRouter();
  const [phase, setPhase] = useState<SubmissionPhase>({ kind: 'idle' });
  const last = useRef<PendingCapture | null>(null);

  function apply(result: CaptureResponse, signedIn: boolean): void {
    if (!result.ok) {
      setPhase(
        result.code === undefined
          ? { kind: 'failed', message: result.message }
          : { kind: 'failed', message: result.message, code: result.code },
      );
      return;
    }
    const { outcome } = result;
    if (outcome.status === 'untracked') {
      setPhase({ kind: 'untracked', name: outcome.name, externalId: outcome.externalId });
      return;
    }
    last.current = null;
    setPhase({ kind: 'done', deckId: outcome.deckId, changed: outcome.changedSinceLastObservation });
    const deckPage = routes.deck(outcome.deckId, { captured: true });
    if (signedIn) window.location.replace(deckPage);
    else router.replace(deckPage);
  }

  async function submit(
    payload: CaptureRequestBody['payload'],
    method: CaptureMethod,
    key?: string,
  ): Promise<CaptureResponse> {
    last.current = { payload, method, key };
    setPhase({ kind: 'submitting' });
    const result = await postCapture(payload, method, false, key);
    apply(result, key !== undefined);
    return result;
  }

  async function track(): Promise<void> {
    const pending = last.current;
    if (pending === null || phase.kind !== 'untracked') return;
    setPhase({ kind: 'tracking', name: phase.name });
    apply(await postCapture(pending.payload, pending.method, true, pending.key), pending.key !== undefined);
  }

  function reset(): void {
    last.current = null;
    setPhase({ kind: 'idle' });
  }

  return { phase, submit, track, reset };
}
