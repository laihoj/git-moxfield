/**
 * Browser capture protocol between the "Send to git-moxfield" bookmarklet (running on a
 * Moxfield deck page) and git-moxfield's `/capture` page and capture endpoints.
 *
 * This module is imported by client components: it must stay dependency-free and
 * browser-safe (no Node built-ins, no zod; the only runtime imports are the leaf modules of
 * `src/core`, which have no imports of their own).
 *
 * ## Payloads and their transport encoding (ADR 0008)
 *
 * What travels is the **capture payload**: the {@link CaptureEnvelope} JSON string,
 * gzip-compressed and tagged (`gm-gzip-base64url:…`) by the bookmarklet, or the plain
 * JSON in browsers without `CompressionStream` and from bookmarklets made before
 * compression. The wire format, its size limits and the encoders live in
 * `./capture-codec-protocol`, the server's decoder in `./capture-codec`. The payload is
 * the same text on every path: the PAYLOAD message's `json`, the clipboard fallback, the
 * same-tab form's {@link CAPTURE_FORM_FIELD} and the `payload` of {@link CaptureRequestBody}.
 * The capture endpoints decode it before anything parses it; a typical 0.8 MB deck
 * travels as about 0.15 MB, far below the hosting platform's request limit (6 MB on
 * Netlify).
 *
 * Compression needs no new envelope version: the tag makes the transport encoding
 * self-describing, and untagged payloads are still plain JSON. Version-2 bookmarklets
 * made before compression therefore keep working: the capture page and the paste form
 * compress what they hand over before sending it, and only their same-tab form posts
 * arrive plain, within the plain-payload limit (`MAX_PLAIN_CAPTURE_BYTES`, 1.4 MB).
 *
 * ## Version 2 (accounts, ADR 0006)
 *
 * Every bookmarklet belongs to one user: it embeds that user's **bookmarklet key**
 * ({@link BOOKMARKLET_KEY_PATTERN}, `gmk_…`), in both modes. Running it captures the
 * deck into the key owner's workspace *and signs that browser in*. Changes from version 1:
 *
 * - The envelope's `version` is 2. Version-1 envelopes (bookmarklets made before
 *   accounts) are rejected with a message asking to create a new bookmarklet.
 * - PAYLOAD carries the key: `{ t, n, json, key }`.
 * - The capture page posts the key along with the deck to {@link CAPTURE_API_PATH}
 *   ({@link CaptureRequestBody}); the endpoint authenticates the key, or else the
 *   browser's session cookie, and sets the session cookie.
 * - The same-tab form's {@link CAPTURE_FORM_TOKEN_FIELD} carries the key instead of the
 *   installation-wide capture token, which no longer exists.
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
 *    The result is serialized as a {@link CaptureEnvelope} JSON string and encoded as the
 *    capture payload (compressed when the browser can).
 * 4. The capture page reads the nonce from `location.hash` ({@link readCaptureNonce}),
 *    and posts `{ t: READY, n }` to `window.opener` with `targetOrigin` = the Moxfield
 *    site origin, every {@link CAPTURE_READY_INTERVAL_MS} ms until it receives an
 *    answer or {@link CAPTURE_TIMEOUT_MS} elapse. Repetition covers the race where the
 *    page loads before the bookmarklet's listener is ready.
 * 5. The bookmarklet accepts a message only if `event.source === popup`,
 *    `event.origin === appOrigin` and `event.data.n === nonce`. On the first READY it
 *    waits for step 3 and replies `{ t: PAYLOAD, n, json, key }` (`json` = the capture
 *    payload, `key` = the bookmarklet key) via `popup.postMessage(…, appOrigin)` — never
 *    with `'*'`, so the key only ever reaches the exact git-moxfield origin. If capturing
 *    failed it replies `{ t: ERROR, n, message }` instead. Later READYs are ignored.
 * 6. The capture page accepts PAYLOAD/ERROR only if `event.source === window.opener`,
 *    `event.origin` is an allowed Moxfield origin and `event.data.n` equals its nonce.
 *    It compresses a plain payload (one from a bookmarklet made before compression),
 *    checks the payload against the size limits (`exceedsCapturePayloadLimit`), submits
 *    it and the key to the git-moxfield server (same-origin `POST` {@link CAPTURE_API_PATH},
 *    body {@link CaptureRequestBody}), stops sending READY and posts `{ t: DONE, n }` to the
 *    opener (`targetOrigin` = Moxfield site origin). If the server rejects the capture,
 *    it posts `{ t: ERROR, n, message }` to the opener instead of DONE. The key is kept
 *    in memory only for these requests (never stored, rendered or logged).
 * 7. On DONE the bookmarklet removes its listener and shows "Sent"; on ERROR it removes
 *    its listener and shows the message. It gives up after {@link CAPTURE_TIMEOUT_MS}.
 *
 * ## Fallbacks
 *
 * - Popup blocked (`window.open` returned `null`): the bookmarklet copies the capture
 *   payload to the clipboard and asks the user to paste it at
 *   `{appUrl}{CAPTURE_PAGE_PATH}?{CAPTURE_PASTE_QUERY}`, whose paste form reads compressed
 *   payloads as well as plain JSON.
 * - Same-tab mode (mobile / in-app browsers, no popups): after fetching, the bookmarklet
 *   submits a hidden `<form method="POST" action="{appUrl}{CAPTURE_FORM_PATH}"
 *   target="_self">` (browser-default `application/x-www-form-urlencoded`) with two
 *   fields: {@link CAPTURE_FORM_TOKEN_FIELD}, the user's bookmarklet key, and
 *   {@link CAPTURE_FORM_FIELD}, the capture payload. Compressed, a payload is base64url,
 *   which form encoding leaves as it is.
 *
 *   The key is what authenticates the post. Its `Origin` header cannot: browsers send
 *   `Origin: null` for this cross-site form post from https://moxfield.com to an
 *   http:// git-moxfield (the referrer policy hides the origin on an https → http
 *   downgrade), and any other site can produce `Origin: null` too. Nor can the session
 *   cookie: it is `SameSite=Lax`, so browsers do not send it with a cross-site `POST`.
 *   The endpoint therefore answers with a short-lived hand-off cookie and a redirect
 *   through `/api/auth/handoff`, where the browser's own session cookie is visible again
 *   (see that route).
 *
 * ## The capture endpoint
 *
 * `POST {@link CAPTURE_API_PATH}` takes same-origin JSON ({@link CaptureRequestBody}).
 * It authenticates the `key` when one is sent (a wrong or revoked key is an error, never
 * silently replaced by the session), otherwise the session cookie; without either it
 * answers 401 ({@link CaptureErrorBody} with code `unauthenticated`). Manual paste sends
 * no key and so requires a signed-in session. A payload over the size limits is answered
 * with 413, one that cannot be decoded or parsed with 400; the same-tab endpoint
 * redirects to the paste form with `error=too-large` or `error=invalid` instead.
 */
import { isRecord } from '@/core/guards';
import { tokenPattern } from '@/core/token-format';

import type { CapturedIngestMethod } from '../deck-source';

/** `kind` of a {@link CaptureEnvelope}. */
export const CAPTURE_ENVELOPE_KIND = 'git-moxfield/capture';

/** Version of the envelope and message protocol (2: per-user bookmarklet keys). */
export const CAPTURE_PROTOCOL_VERSION = 2;

/** Capture page → opener: "I am loaded; send the payload". `{ t, n }`. */
export const READY = 'git-moxfield:ready';
/** Opener → capture page: the captured deck. `{ t, n, json, key }`. */
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

/**
 * Upper bound for the capture's JSON text (characters / bytes) accepted by git-moxfield:
 * the envelope once decoded. Compressed payloads are inflated up to this size at most;
 * what may travel is limited by `./capture-codec-protocol`.
 */
export const MAX_CAPTURE_BYTES = 8_000_000;

/** Interval at which the capture page repeats READY. */
export const CAPTURE_READY_INTERVAL_MS = 500;

/** How long both sides wait for each other before giving up. */
export const CAPTURE_TIMEOUT_MS = 120_000;

/** git-moxfield page opened by the bookmarklet (`#n={nonce}` appended). */
export const CAPTURE_PAGE_PATH = '/capture';

/** Query parameter of the capture page that selects its mode, and the value of manual paste mode. */
export const CAPTURE_MODE_PARAM = 'mode';
export const CAPTURE_PASTE_MODE = 'paste';

/** Query string (without `?`) of the capture page's manual paste mode. */
export const CAPTURE_PASTE_QUERY = `${CAPTURE_MODE_PARAM}=${CAPTURE_PASTE_MODE}`;

/** The `?error=` codes `POST {@link CAPTURE_FORM_PATH}` sends the capture page (never the payload). */
const CAPTURE_FORM_ERRORS = ['invalid', 'too-large', 'failed'] as const;

export type CaptureFormError = (typeof CAPTURE_FORM_ERRORS)[number];

/** The code in a query value, or `null` for anything else (the page shows no notice then). */
export function parseCaptureFormError(value: unknown): CaptureFormError | null {
  return CAPTURE_FORM_ERRORS.find((code) => code === value) ?? null;
}

/** Route receiving same-tab form posts. */
export const CAPTURE_FORM_PATH = '/api/capture/form';

/** Form field holding the capture payload (compressed or plain envelope JSON) in same-tab mode. */
export const CAPTURE_FORM_FIELD = 'payload';

/** Form field holding the user's bookmarklet key in same-tab mode. */
export const CAPTURE_FORM_TOKEN_FIELD = 'token';

/** A bookmarklet key: the `key` token of the account system, `gmk_` + 256 random bits as base64url. */
export const BOOKMARKLET_KEY_PATTERN = tokenPattern('key');

/** The remedy every refusal caused by an outdated or revoked bookmarklet ends with. */
export const NEW_BOOKMARKLET_HINT = 'Create a new one on git-moxfield’s Connect Moxfield page.';

/** Endpoint receiving captures from the capture page and the paste form. */
export const CAPTURE_API_PATH = '/api/capture';

/** How a capture reached git-moxfield. */
export const CAPTURE_REQUEST_METHODS = [
  'browser-capture',
  'manual-paste',
] as const satisfies readonly CapturedIngestMethod[];

export type CaptureRequestMethod = (typeof CAPTURE_REQUEST_METHODS)[number];

/**
 * Machine-readable reasons for 401s: `unauthenticated` (no key and no session: sign in)
 * or `invalid-key` (the bookmarklet's key is unknown or revoked: make a new one).
 */
export const CAPTURE_FAILURE_CODES = ['unauthenticated', 'invalid-key'] as const;

export type CaptureFailureCode = (typeof CAPTURE_FAILURE_CODES)[number];

/** JSON body of `POST {@link CAPTURE_API_PATH}`. */
export interface CaptureRequestBody {
  /**
   * The capture payload (`./capture-codec-protocol`): the envelope JSON or the paste
   * form's JSON (a deck, or `{ deck, primer }` with both as JSON strings), compressed or
   * plain. An object (`{ deck, primer }`) is accepted as it is, never decoded.
   */
  payload: string | Record<string, unknown>;
  method: CaptureRequestMethod;
  /** `false`: an untracked deck is answered with `status: 'untracked'` instead of being tracked. */
  track: boolean;
  /**
   * "Continue an existing deck's history": the id of one of the user's decks that the
   * captured deck continues (it is pointed at the captured Moxfield deck, which becomes
   * its working state). Offered for a deck answered with `status: 'untracked'`.
   */
  relinkDeckId?: string;
  /** The bookmarklet key from the PAYLOAD message (popup mode); omitted for manual paste. */
  key?: string;
}

/** Error body of the capture endpoint (any non-2xx status). */
export interface CaptureErrorBody {
  /** User-facing message. */
  error: string;
  /** Machine-readable reason for 401s, see {@link CAPTURE_FAILURE_CODES}. */
  code?: CaptureFailureCode;
}

export type CaptureMessageType = (typeof CAPTURE_MESSAGE_TYPES)[keyof typeof CAPTURE_MESSAGE_TYPES];

export interface CaptureReadyMessage {
  t: typeof READY;
  n: string;
}

export interface CapturePayloadMessage {
  t: typeof PAYLOAD;
  n: string;
  /** The capture payload: the {@link CaptureEnvelope} JSON, compressed or plain. */
  json: string;
  /**
   * The bookmarklet key ({@link BOOKMARKLET_KEY_PATTERN}); absent from version-1
   * bookmarklets, whose envelope the server rejects with an upgrade message.
   */
  key?: string;
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
      return typeof value.json === 'string' && (value.key === undefined || typeof value.key === 'string');
    case ERROR:
      return typeof value.message === 'string';
    default:
      return false;
  }
}

/**
 * What a captured or pasted JSON object is, for the server and the paste form's preview
 * alike: a bookmarklet `envelope`, a `wrapper` (`{ deck, primer? }`, as the paste form
 * builds it), the primer endpoint's JSON, or `other` (taken to be a deck).
 */
export function classifyCaptureJson(
  value: Record<string, unknown>,
): 'envelope' | 'wrapper' | 'primer' | 'other' {
  if (value.kind === CAPTURE_ENVELOPE_KIND) return 'envelope';
  if (Object.hasOwn(value, 'deck') && !Object.hasOwn(value, 'publicId')) return 'wrapper';
  if (
    typeof value.content === 'string' &&
    !Object.hasOwn(value, 'publicId') &&
    !Object.hasOwn(value, 'boards')
  ) {
    return 'primer';
  }
  return 'other';
}

/** Strict shallow check that a parsed value is a {@link CaptureEnvelope} of this protocol version. */
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
