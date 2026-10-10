/**
 * Browser capture protocol between the "Send to git-moxfield" bookmarklet (running on a
 * Moxfield deck page) and git-moxfield's `/capture` page.
 *
 * This module is imported by client components: it must stay dependency-free and
 * browser-safe (no Node built-ins, no zod, no imports at all).
 *
 * ## Popup mode (desktop)
 *
 * 1. The user runs the bookmarklet on `{siteOrigin}/decks/{publicId}`.
 * 2. Synchronously (inside the click's user activation) the bookmarklet generates a
 *    128-bit nonce (32 lowercase hex chars, {@link NONCE_PATTERN}) and opens
 *    `{appUrl}/capture#n={nonce}` with `window.open(url, '_blank')`. The bookmarklet
 *    window is the popup's `window.opener`.
 * 3. The bookmarklet fetches `GET {apiBase}/v3/decks/all/{publicId}` and then
 *    `GET {apiBase}/v1/decks/{deck.id}/primer` with the user's browser. A primer failure
 *    never aborts the capture: it yields `primer: null` and a `primerError` message.
 *    The result is serialized as a {@link CaptureEnvelope} JSON string.
 * 4. The capture page reads the nonce from `location.hash` ({@link readCaptureNonce}),
 *    and posts `{ t: READY, n }` to `window.opener` with `targetOrigin` = the Moxfield
 *    site origin, every {@link CAPTURE_READY_INTERVAL_MS} ms until it receives an
 *    answer or {@link CAPTURE_TIMEOUT_MS} elapse. Repetition covers the race where the
 *    page loads before the bookmarklet's listener is ready.
 * 5. The bookmarklet accepts a message only if `event.source === popup`,
 *    `event.origin === appOrigin` and `event.data.n === nonce`. On the first READY it
 *    waits for step 3 and replies `{ t: PAYLOAD, n, json }` (`json` = the envelope
 *    string) via `popup.postMessage(…, appOrigin)` — never with `'*'`. If capturing
 *    failed it replies `{ t: ERROR, n, message }` instead. Later READYs are ignored.
 * 6. The capture page accepts PAYLOAD/ERROR only if `event.source === window.opener`,
 *    `event.origin` is an allowed Moxfield origin and `event.data.n` equals its nonce.
 *    It checks `json.length <= MAX_CAPTURE_BYTES`, submits the envelope to the
 *    git-moxfield server (same-origin), stops sending READY and posts `{ t: DONE, n }`
 *    to the opener (`targetOrigin` = Moxfield site origin). If the server rejects the
 *    capture, it posts `{ t: ERROR, n, message }` to the opener instead of DONE.
 * 7. On DONE the bookmarklet removes its listener and shows "Sent"; on ERROR it removes
 *    its listener and shows the message. It gives up after {@link CAPTURE_TIMEOUT_MS}.
 *
 * ## Fallbacks
 *
 * - Popup blocked (`window.open` returned `null`): the bookmarklet copies the envelope
 *   JSON to the clipboard and asks the user to paste it at
 *   `{appUrl}{CAPTURE_PAGE_PATH}?{CAPTURE_PASTE_QUERY}`.
 * - Same-tab mode (mobile / in-app browsers, no popups): after fetching, the bookmarklet
 *   submits a hidden `<form method="POST" action="{appUrl}{CAPTURE_FORM_PATH}"
 *   target="_self">` (browser-default `application/x-www-form-urlencoded`) with two
 *   fields: {@link CAPTURE_FORM_TOKEN_FIELD}, this installation's capture token
 *   ({@link CAPTURE_TOKEN_PATTERN}, baked into the bookmarklet when git-moxfield builds
 *   it), and {@link CAPTURE_FORM_FIELD}, the envelope JSON string.
 *
 *   The token is what authenticates the post. Its `Origin` header cannot: browsers send
 *   `Origin: null` for this cross-site form post from https://moxfield.com to an
 *   http:// git-moxfield (the referrer policy hides the origin on an https → http
 *   downgrade), and any other site can produce `Origin: null` too. The popup mode needs
 *   no token: its capture page submits the deck same-origin.
 */

/** `kind` of a {@link CaptureEnvelope}. */
export const CAPTURE_ENVELOPE_KIND = 'git-moxfield/capture';

/** Version of the envelope and message protocol. */
export const CAPTURE_PROTOCOL_VERSION = 1;

/** Capture page → opener: "I am loaded; send the payload". `{ t, n }`. */
export const READY = 'git-moxfield:ready';
/** Opener → capture page: the captured deck. `{ t, n, json }`. */
export const PAYLOAD = 'git-moxfield:payload';
/**
 * Capturing or importing failed. `{ t, n, message }`. Sent by the opener when it could
 * not read the deck, or by the capture page when git-moxfield rejected the capture.
 */
export const ERROR = 'git-moxfield:error';
/** Capture page → opener: payload received and handed to the server. `{ t, n }`. */
export const DONE = 'git-moxfield:done';

/** All message types, for code that prefers a namespace. */
export const CAPTURE_MESSAGE_TYPES = { READY, PAYLOAD, ERROR, DONE } as const;

/** One-time nonce: 128 bits as 32 lowercase hex characters. */
export const NONCE_PATTERN = /^[0-9a-f]{32}$/;

/** Upper bound for an envelope JSON string (characters / bytes) accepted by git-moxfield. */
export const MAX_CAPTURE_BYTES = 8_000_000;

/** Interval at which the capture page repeats READY. */
export const CAPTURE_READY_INTERVAL_MS = 500;

/** How long both sides wait for each other before giving up. */
export const CAPTURE_TIMEOUT_MS = 120_000;

/** git-moxfield page opened by the bookmarklet (`#n={nonce}` appended). */
export const CAPTURE_PAGE_PATH = '/capture';

/** Query string (without `?`) of the capture page's manual paste mode. */
export const CAPTURE_PASTE_QUERY = 'mode=paste';

/** Route receiving same-tab form posts. */
export const CAPTURE_FORM_PATH = '/api/capture/form';

/** Form field holding the envelope JSON in same-tab mode. */
export const CAPTURE_FORM_FIELD = 'payload';

/** Form field holding the installation's capture token in same-tab mode. */
export const CAPTURE_FORM_TOKEN_FIELD = 'token';

/** An installation's capture token: 256 random bits as 64 lowercase hex characters. */
export const CAPTURE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export type CaptureMessageType = (typeof CAPTURE_MESSAGE_TYPES)[keyof typeof CAPTURE_MESSAGE_TYPES];

export interface CaptureReadyMessage {
  t: typeof READY;
  n: string;
}

export interface CapturePayloadMessage {
  t: typeof PAYLOAD;
  n: string;
  /** {@link CaptureEnvelope} serialized as JSON. */
  json: string;
}

export interface CaptureErrorMessage {
  t: typeof ERROR;
  n: string;
  message: string;
}

export interface CaptureDoneMessage {
  t: typeof DONE;
  n: string;
}

export type CaptureMessage =
  CaptureReadyMessage | CapturePayloadMessage | CaptureErrorMessage | CaptureDoneMessage;

/** What the bookmarklet captures. Deck and primer are untrusted, unvalidated JSON. */
export interface CaptureEnvelope {
  kind: typeof CAPTURE_ENVELOPE_KIND;
  version: typeof CAPTURE_PROTOCOL_VERSION;
  source: 'moxfield';
  /** Moxfield page the capture ran on (origin + path, no query or fragment). */
  pageUrl: string;
  /** ISO timestamp from the user's browser clock. */
  capturedAt: string;
  /** JSON of `GET /v3/decks/all/{publicId}`. */
  deck: unknown;
  /** JSON of `GET /v1/decks/{deck.id}/primer`, or `null` when it could not be fetched. */
  primer: unknown;
  /** Why the primer is missing, or `null`. */
  primerError: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural check of a `postMessage` payload: a known type, a well-formed nonce, and
 * the type-specific string fields. Origin, source and nonce equality are the caller's job.
 */
export function isCaptureMessage(value: unknown): value is CaptureMessage {
  if (!isRecord(value) || typeof value.n !== 'string' || !NONCE_PATTERN.test(value.n)) return false;
  switch (value.t) {
    case READY:
    case DONE:
      return true;
    case PAYLOAD:
      return typeof value.json === 'string';
    case ERROR:
      return typeof value.message === 'string';
    default:
      return false;
  }
}

/** Shallow check that a parsed value is a {@link CaptureEnvelope} of this protocol version. */
export function isCaptureEnvelope(value: unknown): value is CaptureEnvelope {
  return (
    isRecord(value) &&
    value.kind === CAPTURE_ENVELOPE_KIND &&
    value.version === CAPTURE_PROTOCOL_VERSION &&
    value.source === 'moxfield' &&
    isRecord(value.deck)
  );
}

/** Reads the nonce from a capture page hash (`#n=<nonce>`); `null` when absent or malformed. */
export function readCaptureNonce(hash: string): string | null {
  const nonce = new URLSearchParams(hash.replace(/^#/, '')).get('n');
  return nonce !== null && NONCE_PATTERN.test(nonce) ? nonce : null;
}
