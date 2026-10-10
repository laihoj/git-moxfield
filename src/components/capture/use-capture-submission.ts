'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { routes } from '@/lib/routes';

import {
  postCapture,
  type CaptureFailureCode,
  type CaptureMethod,
  type CaptureResponse,
} from './capture-api';
import { prepareCapturePayload } from './capture-payload';

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
   * Sends capture text (JSON, or a payload the bookmarklet already compressed) without
   * tracking unknown decks, compressed when the browser can (`prepareCapturePayload`).
   * Resolves with the server's answer, or with the reason it was not sent (too large).
   * `key` is the bookmarklet key that came with a bookmarklet's deck (see `postCapture`).
   */
  submit: (text: string, method: CaptureMethod, key?: string) => Promise<CaptureResponse>;
  /** Confirms tracking the untracked deck from the last submission and sends it again. */
  track: () => Promise<void>;
  reset: () => void;
}

interface PendingCapture {
  /** The prepared (compressed when possible) payload. */
  payload: string;
  method: CaptureMethod;
  key: string | undefined;
}

/**
 * Submission flow shared by the bookmarklet receiver and the paste form: compress,
 * submit (`track: false`), ask before tracking an unknown deck, then open the deck page.
 * The payload (and a bookmarklet key) is kept in a ref, never in rendered state: the
 * payload can be megabytes, and the key is a secret. Tracking sends the same compressed
 * payload again. Only the latest submission counts: the answer to one that was reset or
 * replaced in the meantime is ignored.
 *
 * A capture sent with a key has signed this browser in (possibly as another user than
 * the page was rendered for), so the deck page is then opened with a full page load:
 * every part of the page, the header's user menu included, renders for the new session.
 */
export function useCaptureSubmission(): CaptureSubmission {
  const router = useRouter();
  const [phase, setPhase] = useState<SubmissionPhase>({ kind: 'idle' });
  const last = useRef<PendingCapture | null>(null);
  /** Incremented by every submission and reset, so that stale answers are ignored. */
  const generation = useRef(0);

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

  async function submit(text: string, method: CaptureMethod, key?: string): Promise<CaptureResponse> {
    const current = ++generation.current;
    last.current = null;
    setPhase({ kind: 'submitting' });
    const prepared = await prepareCapturePayload(text);
    if (!prepared.ok) {
      const refused: CaptureResponse = { ok: false, message: prepared.message };
      if (current === generation.current) apply(refused, false);
      return refused;
    }
    if (current === generation.current) last.current = { payload: prepared.payload, method, key };
    const result = await postCapture(prepared.payload, method, false, key);
    if (current === generation.current) apply(result, key !== undefined);
    return result;
  }

  async function track(): Promise<void> {
    const pending = last.current;
    if (pending === null || phase.kind !== 'untracked') return;
    const current = ++generation.current;
    setPhase({ kind: 'tracking', name: phase.name });
    const result = await postCapture(pending.payload, pending.method, true, pending.key);
    if (current === generation.current) apply(result, pending.key !== undefined);
  }

  function reset(): void {
    generation.current += 1;
    last.current = null;
    setPhase({ kind: 'idle' });
  }

  return { phase, submit, track, reset };
}
