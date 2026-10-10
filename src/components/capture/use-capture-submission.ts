'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { routes } from '@/lib/routes';
import type { RelinkCandidateDTO } from '@/server/services/types';

import {
  postCapture,
  type CaptureFailureCode,
  type CaptureMethod,
  type CaptureRequestOptions,
  type CaptureResponse,
} from './capture-api';
import { prepareCapturePayload } from './capture-payload';

export type SubmissionPhase =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  /**
   * The deck is not tracked: the user tracks it, or continues one of their decks with it
   * (`decks`, see `DeckServices.ingestCapture`), or cancels.
   */
  | { kind: 'untracked'; name: string; externalId: string; decks: RelinkCandidateDTO[] }
  | { kind: 'tracking'; name: string }
  /** Continuing the history of the user's deck `deckName` with the captured deck. */
  | { kind: 'relinking'; name: string; deckName: string }
  | { kind: 'done'; deckId: string; changed: boolean; relinked: boolean }
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
  /**
   * Sends the untracked deck from the last submission again, to continue the history of
   * the user's deck `deckId` (one of the untracked phase's `decks`).
   */
  relink: (deckId: string) => Promise<void>;
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
 * submit (`track: false`), ask before tracking an unknown deck (or continuing one of the
 * user's decks with it), then open the deck page.
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

  /**
   * Shows the server's answer. `signedIn`: the request carried a bookmarklet key (see
   * above); `relinked`: it continued one of the user's decks.
   */
  function apply(result: CaptureResponse, signedIn: boolean, relinked = false): void {
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
      setPhase({
        kind: 'untracked',
        name: outcome.name,
        externalId: outcome.externalId,
        decks: outcome.decks,
      });
      return;
    }
    last.current = null;
    setPhase({
      kind: 'done',
      deckId: outcome.deckId,
      changed: outcome.changedSinceLastObservation,
      relinked,
    });
    const deckPage = routes.deck(outcome.deckId, { captured: true, relinked });
    if (signedIn) window.location.replace(deckPage);
    else router.replace(deckPage);
  }

  function send(
    pending: PendingCapture,
    options: Omit<CaptureRequestOptions, 'key'>,
  ): Promise<CaptureResponse> {
    return postCapture(
      pending.payload,
      pending.method,
      pending.key === undefined ? options : { ...options, key: pending.key },
    );
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
    const pending: PendingCapture = { payload: prepared.payload, method, key };
    if (current === generation.current) last.current = pending;
    const result = await send(pending, { track: false });
    if (current === generation.current) apply(result, key !== undefined);
    return result;
  }

  async function track(): Promise<void> {
    const pending = last.current;
    if (pending === null || phase.kind !== 'untracked') return;
    const current = ++generation.current;
    setPhase({ kind: 'tracking', name: phase.name });
    const result = await send(pending, { track: true });
    if (current === generation.current) apply(result, pending.key !== undefined);
  }

  async function relink(deckId: string): Promise<void> {
    const pending = last.current;
    if (pending === null || phase.kind !== 'untracked') return;
    const deck = phase.decks.find((candidate) => candidate.id === deckId);
    if (deck === undefined) return;
    const current = ++generation.current;
    setPhase({ kind: 'relinking', name: phase.name, deckName: deck.name });
    const result = await send(pending, { track: false, relinkDeckId: deckId });
    if (current === generation.current) apply(result, pending.key !== undefined, true);
  }

  function reset(): void {
    generation.current += 1;
    last.current = null;
    setPhase({ kind: 'idle' });
  }

  return { phase, submit, track, relink, reset };
}
