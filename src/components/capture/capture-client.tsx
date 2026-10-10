'use client';

import { useEffect, useEffectEvent, useState, useSyncExternalStore, type ReactNode } from 'react';

import {
  CAPTURE_READY_INTERVAL_MS,
  CAPTURE_TIMEOUT_MS,
  DONE,
  ERROR,
  isCaptureMessage,
  MAX_CAPTURE_BYTES,
  PAYLOAD,
  READY,
  readCaptureNonce,
  type CaptureMessage,
} from '@/integrations/moxfield/capture-protocol';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

import { CaptureStatus, WaitingPanel } from './capture-status';
import { FormErrorNotice, PasteCapture } from './paste-capture';
import { useCaptureSubmission } from './use-capture-submission';

/** The bookmarklet hand-over this window was opened for: its nonce and opener. */
interface CaptureSession {
  nonce: string | null;
  opener: Window | null;
}

/**
 * Read once per page load and cached, because the nonce's URL fragment is removed
 * right after mount (it must not linger in history or be bookmarked).
 */
let session: CaptureSession | undefined;

function readSession(): CaptureSession {
  if (session === undefined) {
    const opener: unknown = window.opener;
    session = {
      nonce: readCaptureNonce(window.location.hash),
      opener: typeof opener === 'object' && opener !== null ? (opener as Window) : null,
    };
  }
  return session;
}

/** Caches the session, then drops the `#n=…` fragment from the address bar and history. */
function stripNonceFromUrl(): void {
  readSession();
  if (window.location.hash !== '') {
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }
}

const subscribeNever = (): (() => void) => () => undefined;

/** `null` on the server and during hydration; the session afterwards. */
function useCaptureSession(): CaptureSession | null {
  return useSyncExternalStore(subscribeNever, readSession, () => null);
}

type ReceiverPhase =
  | { kind: 'waiting' }
  | { kind: 'received' }
  | { kind: 'timeout' }
  | { kind: 'opener-error'; message: string };

export interface CaptureClientProps {
  /** Origins allowed to send captures (Moxfield's site origin by default). */
  allowedOrigins: readonly string[];
  apiBaseUrl: string;
  siteOrigin: string;
  /** `paste` skips the bookmarklet hand-over (`/capture?mode=paste`). */
  initialMode: 'auto' | 'paste';
  /** Error code from the same-tab capture endpoint (`?error=`). */
  formError: string | null;
}

/**
 * Receiving side of the bookmarklet protocol (see `capture-protocol.ts`): announces
 * READY to the opener until the Moxfield tab answers, accepts the payload only from
 * the opener, an allowed origin and with the matching nonce, imports it, and reports
 * DONE or ERROR back. Without an opener or nonce, or after a timeout, it offers the
 * manual paste form.
 */
export function CaptureClient({
  allowedOrigins,
  apiBaseUrl,
  siteOrigin,
  initialMode,
  formError,
}: CaptureClientProps) {
  const current = useCaptureSession();
  const [mode, setMode] = useState(initialMode);
  const [phase, setPhase] = useState<ReceiverPhase>({ kind: 'waiting' });
  const submission = useCaptureSubmission();
  const importPayload = useEffectEvent((json: string) => submission.submit(json, 'browser-capture'));
  /** Primitive dependency: the origins array is a new object on every server render. */
  const originsKey = allowedOrigins.join(' ');

  const handOver = mode === 'auto' && (current?.nonce ?? null) !== null && (current?.opener ?? null) !== null;

  useEffect(stripNonceFromUrl, []);

  useEffect(() => {
    if (!handOver) return;
    const { nonce, opener } = readSession();
    if (nonce === null || opener === null) return;
    const allowed = new Set(originsKey.split(' ').filter((origin) => origin !== ''));
    let finished = false;

    const post = (message: CaptureMessage, origin: string): void => {
      try {
        opener.postMessage(message, origin);
      } catch {
        // The opener navigated away or closed; nothing to report to.
      }
    };
    const announce = (): void => {
      // Exactly one allowed origin matches the opener; the browser drops the others.
      for (const origin of allowed) post({ t: READY, n: nonce }, origin);
    };
    const stop = (): void => {
      finished = true;
      window.clearInterval(interval);
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
    };

    const onMessage = (event: MessageEvent): void => {
      if (finished || event.source !== opener || !allowed.has(event.origin)) return;
      const data: unknown = event.data;
      if (!isCaptureMessage(data) || data.n !== nonce) return;
      if (data.t === ERROR) {
        stop();
        setPhase({ kind: 'opener-error', message: data.message });
        return;
      }
      if (data.t !== PAYLOAD) return;
      stop();
      const replyOrigin = event.origin;
      if (data.json.length > MAX_CAPTURE_BYTES) {
        const message = 'The deck is too large to import.';
        post({ t: ERROR, n: nonce, message }, replyOrigin);
        setPhase({ kind: 'opener-error', message });
        return;
      }
      setPhase({ kind: 'received' });
      void importPayload(data.json).then((result) => {
        post(
          result.ok ? { t: DONE, n: nonce } : { t: ERROR, n: nonce, message: result.message },
          replyOrigin,
        );
      });
    };

    window.addEventListener('message', onMessage);
    const interval = window.setInterval(announce, CAPTURE_READY_INTERVAL_MS);
    const timeout = window.setTimeout(() => {
      stop();
      setPhase({ kind: 'timeout' });
    }, CAPTURE_TIMEOUT_MS);
    announce();
    return stop;
  }, [handOver, originsKey]);

  const paste = (notice?: ReactNode) => (
    <PasteCapture
      apiBaseUrl={apiBaseUrl}
      siteOrigin={siteOrigin}
      notice={
        <>
          {formError !== null && <FormErrorNotice code={formError} />}
          {notice}
        </>
      }
    />
  );

  if (mode === 'paste') return <Shell title="Paste a deck from Moxfield">{paste()}</Shell>;
  if (current === null) {
    return (
      <Shell title="Send to git-moxfield">
        <WaitingPanel title="Getting ready…" />
      </Shell>
    );
  }
  if (!handOver) {
    return (
      <Shell title="Paste a deck from Moxfield">
        {paste(
          <Alert tone="info" title="Use the bookmarklet, or paste">
            This page receives decks from the “Send to git-moxfield” bookmarklet on a Moxfield deck page. You
            can also paste the deck data below.
          </Alert>,
        )}
      </Shell>
    );
  }

  if (phase.kind === 'timeout') {
    return (
      <Shell title="Paste a deck from Moxfield">
        {paste(
          <Alert tone="warn" title="No answer from the Moxfield tab">
            The deck did not arrive. Run the bookmarklet again on the deck page, or paste the deck data below.
          </Alert>,
        )}
      </Shell>
    );
  }

  return (
    <Shell title="Send to git-moxfield">
      <Card className="flex flex-col gap-4">
        {phase.kind === 'waiting' && (
          <WaitingPanel title="Waiting for the deck from Moxfield…">
            Keep the Moxfield tab open. This takes a few seconds.
          </WaitingPanel>
        )}
        {phase.kind === 'opener-error' && (
          <Alert tone="error" role="alert" title="Moxfield could not send the deck">
            <span className="break-words">{phase.message}</span>
          </Alert>
        )}
        <CaptureStatus
          phase={submission.phase}
          onTrack={() => {
            void submission.track();
          }}
          onCancel={() => {
            window.close();
            submission.reset();
          }}
        />
        {(phase.kind === 'opener-error' || submission.phase.kind === 'failed') && (
          <div>
            <Button
              variant="secondary"
              onClick={() => {
                setMode('paste');
              }}
            >
              Paste the deck instead
            </Button>
          </div>
        )}
      </Card>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
      {children}
    </div>
  );
}
