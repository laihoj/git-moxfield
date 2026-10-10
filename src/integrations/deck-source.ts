/**
 * Deck source integration boundary.
 *
 * Everything platform-specific (URL formats, HTTP endpoints, payload shapes, import
 * text formats) lives behind this interface. The core (canonical model, diff, history)
 * and the persistence/service layers only ever see {@link RawSourcePayload} as an opaque
 * value and {@link NormalizedDeck} as the result of normalizing it.
 */
import type { CanonicalSnapshot, NormalizedDeck, SourceDeckMetadata } from '@/core/model';
import type { ZoneId } from '@/core/zones';

/** Identifies a deck on a source platform. */
export interface DeckRef {
  /** Source id, e.g. `moxfield`. */
  source: string;
  /** Public deck id on the source, e.g. Moxfield `publicId`. */
  externalId: string;
}

export type ParseDeckUrlResult =
  { ok: true; ref: DeckRef; canonicalUrl: string } | { ok: false; reason: string };

/**
 * Opaque, lossless-ish source payload. Stored compressed and content-addressed so the
 * full source data is never discarded, even though the canonical snapshot keeps only
 * user-controlled deck state.
 */
export interface RawSourcePayload {
  /** Source id, e.g. `moxfield`. */
  source: string;
  /** Versioned media type describing `data`, e.g. `application/vnd.git-moxfield.moxfield-deck.v1+json`. */
  mediaType: string;
  /** The payload. JSON-serializable. Treated as untrusted. */
  data: unknown;
}

/** How a payload reached git-moxfield. */
export type IngestMethod =
  /** The git-moxfield server fetched it from the source API. */
  | 'server'
  /** The user's browser fetched it on the source site (bookmarklet) and handed it over. */
  | 'browser-capture'
  /** The user pasted raw JSON manually. */
  | 'manual-paste';

export type DeckSourceErrorCode =
  /** The URL/id is not a valid deck reference. */
  | 'invalid-ref'
  /** The deck does not exist (deleted, or never existed). */
  | 'not-found'
  /** The deck exists but is private / not accessible anonymously. */
  | 'forbidden'
  /** Requests are blocked by the source's bot protection (e.g. Cloudflare WAF). */
  | 'blocked'
  /** HTTP 429 or equivalent. */
  | 'rate-limited'
  /** Source returned 5xx or is otherwise unavailable. */
  | 'unavailable'
  | 'timeout'
  | 'network'
  /** The response could not be understood (schema changed, not JSON, ...). */
  | 'schema';

/**
 * Brand for {@link isDeckSourceError}. A registered symbol, so errors thrown by a
 * source instance created in another bundler module graph (Next.js server, SSR and
 * route-handler graphs share the process-wide source registry) are still recognized,
 * where `instanceof` against this module's class would fail.
 */
const DECK_SOURCE_ERROR_BRAND: unique symbol = Symbol.for('git-moxfield.DeckSourceError');

export class DeckSourceError extends Error {
  override readonly name = 'DeckSourceError';
  readonly [DECK_SOURCE_ERROR_BRAND] = true;
  readonly code: DeckSourceErrorCode;
  readonly source: string;
  /** HTTP status, when the error came from an HTTP response. */
  readonly status: number | undefined;
  /** Seconds to wait before retrying (from Retry-After or local throttling). */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: DeckSourceErrorCode,
    message: string,
    options: {
      source: string;
      status?: number;
      retryAfterSeconds?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.code = code;
    this.source = options.source;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  /** True for failures where retrying later may succeed. */
  get isTransient(): boolean {
    return (
      this.code === 'rate-limited' ||
      this.code === 'unavailable' ||
      this.code === 'timeout' ||
      this.code === 'network'
    );
  }
}

export function isDeckSourceError(value: unknown): value is DeckSourceError {
  if (value instanceof DeckSourceError) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<Record<typeof DECK_SOURCE_ERROR_BRAND, unknown>>)[DECK_SOURCE_ERROR_BRAND] === true
  );
}

/** One block of restore text, intended to be pasted into one place on the source site. */
export interface RestoreSection {
  zone: ZoneId;
  /** Human label, e.g. `Mainboard`. */
  label: string;
  /** Where to paste it, e.g. `Bulk Edit → Mainboard`. */
  target: string;
  /** Text to paste. Deterministic. Ends with a newline when non-empty. */
  text: string;
  /** Total copies in this section. */
  cardCount: number;
}

/** The primer of a version, ready to paste into the source site's primer editor. */
export interface RestorePrimer {
  /**
   * The primer exactly as captured, in the source's own markup (e.g. Moxfield's
   * `===panel:` directives and `[[Card]]` references), so pasting it reproduces the
   * primer. `''` when the version has no primer.
   */
  text: string;
  /** Where to paste it, e.g. `Deck page › Primer › Edit`. */
  target: string;
}

export interface RestoreExport {
  source: string;
  /** Per-zone sections in canonical zone order. Empty zones included when the target must be cleared. */
  sections: RestoreSection[];
  /** The version's primer, or `null` when it was not captured (then it cannot be restored). */
  primer: RestorePrimer | null;
  /** Single combined text, when the source's importer accepts all zones in one paste. */
  combined: { text: string; note: string } | null;
  /** Ordered, user-facing steps. */
  instructions: string[];
  /** Known limitations of restoring via text, user-facing. */
  limitations: string[];
}

export type ServerFetchStatus =
  /** Server-side fetching is expected to work. */
  | { state: 'available' }
  /** Server-side fetching is disabled by configuration. */
  | { state: 'disabled'; reason: string }
  /** Recent attempts were blocked; fetching is paused until `retryAt`. */
  | { state: 'blocked'; reason: string; retryAt: string };

export interface FetchOptions {
  signal?: AbortSignal;
}

export interface DeckSource {
  /** Stable id, e.g. `moxfield`. */
  readonly id: string;
  readonly displayName: string;

  /** Parses user input (URL or bare id) into a deck reference. Never throws. */
  parseDeckUrl(input: string): ParseDeckUrlResult;

  /** Public URL of the deck on the source site. */
  deckUrl(ref: DeckRef): string;

  /** Whether server-side fetching is currently expected to work. */
  serverFetchStatus(): ServerFetchStatus;

  /**
   * Ends a pause of server-side fetching (after a block or a rate limit) right away, so
   * the next fetch is attempted. Optional: only sources that pause implement it. Used by
   * the end-to-end suite's reset hook (`POST /api/e2e/reset`), never by the UI.
   */
  resumeServerFetch?(): void;

  /**
   * Fetches the full current deck (including primer when retrievable) server-side.
   * @throws {DeckSourceError}
   */
  getDeck(ref: DeckRef, options?: FetchOptions): Promise<RawSourcePayload>;

  /**
   * Fetches only deck metadata. Sources without a cheaper endpoint may implement this
   * via {@link getDeck}.
   * @throws {DeckSourceError}
   */
  getDeckMetadata(ref: DeckRef, options?: FetchOptions): Promise<SourceDeckMetadata>;

  /**
   * Validates an untrusted payload handed over by the user's browser (capture/paste)
   * and wraps it as a {@link RawSourcePayload}.
   * @throws {DeckSourceError} with code `schema` when the payload is unusable.
   */
  parseCapturedPayload(data: unknown): RawSourcePayload;

  /**
   * Converts a raw payload into the canonical model. Pure and deterministic.
   * Non-fatal problems are reported as warnings, never silently dropped.
   * @throws {DeckSourceError} with code `schema` when the payload is unusable.
   */
  normalizeDeck(raw: RawSourcePayload): NormalizedDeck;

  /** Generates text the user can paste into the source site to restore a snapshot. Pure. */
  exportForRestore(snapshot: CanonicalSnapshot): RestoreExport;

  /**
   * Converts source-flavored primer markup (e.g. Moxfield's `===panel:` directives and
   * `[[Card Name]]` references) into portable GitHub-flavored markdown for display.
   * The result is still untrusted and must be rendered without raw HTML. Pure.
   */
  primerToMarkdown(primer: string): string;
}
