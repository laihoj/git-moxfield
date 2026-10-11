/**
 * Server-side HTTP client for Moxfield's (private) API.
 *
 * Polite by construction: requests from one client instance are serialized and spaced
 * by `minRequestIntervalMs`, the User-Agent is honest (never a spoofed browser), only
 * URLs built from the configured API base and validated ids are requested, a
 * Cloudflare block pauses all further requests for `blockBackoffSeconds`, and a 429
 * pauses them for its `Retry-After` (at most `blockBackoffSeconds`).
 */
import { readStreamLimited } from '@/core/streams';

import { DeckSourceError, retryAfterSecondsUntil, type DeckSourceErrorCode } from '../deck-source';

import { DEFAULT_MOXFIELD_USER_AGENT, MOXFIELD_INTERNAL_ID_PATTERN, MOXFIELD_SOURCE_ID } from './constants';
import { isValidMoxfieldPublicId } from './url';

/** Structured logger; compatible with `src/server/logger.ts`. */
export interface MoxfieldLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface MoxfieldHttpClientOptions {
  /** API base URL, e.g. `https://api2.moxfield.com` (a path prefix is allowed). */
  apiBaseUrl: string;
  /** Moxfield-issued User-Agent. Defaults to the honest `git-moxfield/<version>` one. */
  userAgent?: string;
  /** Per-attempt timeout, covering the response body. */
  timeoutMs: number;
  /** Minimum time between the starts of two requests of this instance. */
  minRequestIntervalMs: number;
  /** Pause after a bot-protection block. */
  blockBackoffSeconds: number;
  fetchImpl?: typeof fetch;
  /** Clock in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: MoxfieldLogger;
}

/** Delay before the single retry of a 5xx or network failure. */
const RETRY_DELAY_MS = 1_000;

/**
 * Longest `Retry-After` of a 5xx answer that is still waited for before the single
 * retry. Longer outages are reported right away instead of holding the request queue.
 */
const MAX_RETRY_AFTER_SECONDS = 5;

/** Pause after a 429 answer without a usable `Retry-After`. */
const DEFAULT_RATE_LIMIT_PAUSE_SECONDS = 60;

/** Generous safety cap for a response body (a large deck is a few MB). */
const MAX_RESPONSE_BYTES = 16_000_000;

interface Failure {
  error: DeckSourceError;
  retryable: boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses `Retry-After`: delta-seconds or an HTTP-date (relative to `nowMs`).
 * Returns whole seconds, at least 0, or `undefined` when absent or unparseable.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  const text = value?.trim();
  if (text === undefined || text === '') return undefined;
  if (/^\d+$/.test(text)) return Number(text);
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : retryAfterSecondsUntil(at, nowMs);
}

function isJsonContentType(contentType: string): boolean {
  return /\bjson\b/i.test(contentType);
}

/**
 * Whether an error response is a bot-protection block rather than an API answer:
 * Cloudflare marks its challenge interstitials with `cf-mitigated: challenge` (at any
 * status), and its block pages are a 403 with an HTML (or, behind Cloudflare, any
 * non-JSON) body. Other statuses, notably a 503 maintenance or overload page served
 * through Cloudflare, are outages, not blocks.
 */
function isBotProtectionBlock(response: Response, contentType: string, isJson: boolean): boolean {
  if (response.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge') return true;
  if (response.status !== 403 || isJson) return false;
  return /\btext\/html\b/i.test(contentType) || response.headers.has('cf-ray');
}

/** Releases an unread response body; errors (e.g. an already aborted stream) are irrelevant here. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to release.
  }
}

export class MoxfieldHttpClient {
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly minRequestIntervalMs: number;
  private readonly blockBackoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: MoxfieldLogger | undefined;

  /** Tail of the request queue; each request runs after the previous one settled. */
  private queue: Promise<void> = Promise.resolve();
  private lastRequestStart: number | null = null;
  private blockedUntilMs: number | null = null;
  private rateLimitedUntilMs: number | null = null;

  /** @throws {TypeError} when `apiBaseUrl` is not an absolute http(s) URL. */
  constructor(options: MoxfieldHttpClientOptions) {
    const base = new URL(options.apiBaseUrl);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      throw new TypeError('Moxfield apiBaseUrl must use http or https');
    }
    this.baseUrl = `${base.origin}${base.pathname.replace(/\/+$/, '')}`;
    this.userAgent = options.userAgent ?? DEFAULT_MOXFIELD_USER_AGENT;
    this.timeoutMs = options.timeoutMs;
    this.minRequestIntervalMs = options.minRequestIntervalMs;
    this.blockBackoffMs = options.blockBackoffSeconds * 1000;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.logger = options.logger;
  }

  /**
   * `GET /v3/decks/all/{publicId}` as parsed JSON (unvalidated).
   *
   * @throws {DeckSourceError} `invalid-ref` for a malformed id, or the mapped HTTP error.
   * A `signal` aborted by the caller rejects with the signal's reason instead.
   */
  getDeckJson(publicId: string, signal?: AbortSignal): Promise<unknown> {
    if (!isValidMoxfieldPublicId(publicId)) {
      return Promise.reject(
        this.error('invalid-ref', `Invalid Moxfield deck id: ${JSON.stringify(publicId)}`),
      );
    }
    return this.enqueue(`/v3/decks/all/${encodeURIComponent(publicId)}`, signal);
  }

  /**
   * `GET /v1/decks/{internalId}/primer` as parsed JSON (unvalidated). `internalId` is the
   * deck payload's `id`, not the public id.
   *
   * @throws {DeckSourceError} `schema` for a malformed id, or the mapped HTTP error.
   */
  getPrimerJson(internalId: string, signal?: AbortSignal): Promise<unknown> {
    if (!MOXFIELD_INTERNAL_ID_PATTERN.test(internalId)) {
      return Promise.reject(
        this.error('schema', `Invalid Moxfield internal deck id: ${JSON.stringify(internalId)}`),
      );
    }
    return this.enqueue(`/v1/decks/${encodeURIComponent(internalId)}/primer`, signal);
  }

  /** Epoch ms until which requests are paused after a block, or `null` when not blocked. */
  blockedUntil(): number | null {
    if (this.blockedUntilMs !== null && this.now() >= this.blockedUntilMs) this.blockedUntilMs = null;
    return this.blockedUntilMs;
  }

  /**
   * Epoch ms until which requests are paused because Moxfield answered 429 (for its
   * `Retry-After`), or `null`. Unlike a block, this does not make server fetching
   * unavailable: requests in the window fail fast with `rate-limited` instead.
   */
  rateLimitedUntil(): number | null {
    if (this.rateLimitedUntilMs !== null && this.now() >= this.rateLimitedUntilMs) {
      this.rateLimitedUntilMs = null;
    }
    return this.rateLimitedUntilMs;
  }

  /** Ends a pause after a block or a 429 right away: the next request is sent again. */
  clearPauses(): void {
    this.blockedUntilMs = null;
    this.rateLimitedUntilMs = null;
  }

  private error(
    code: DeckSourceErrorCode,
    message: string,
    extra: { status?: number; retryAfterSeconds?: number; cause?: unknown } = {},
  ): DeckSourceError {
    return new DeckSourceError(code, message, { source: MOXFIELD_SOURCE_ID, ...extra });
  }

  private enqueue(path: string, signal: AbortSignal | undefined): Promise<unknown> {
    const run = this.queue.then(() => this.request(path, signal));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async request(path: string, signal: AbortSignal | undefined): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      const result = await this.attempt(path, signal);
      if (!('error' in result)) return result.body;
      const { error, retryable } = result;
      this.logger?.warn('Moxfield request failed', {
        path,
        status: error.status ?? null,
        code: error.code,
        attempt,
        willRetry: retryable && attempt === 1,
      });
      if (!retryable || attempt > 1) throw error;
      await this.sleep(Math.max(RETRY_DELAY_MS, (error.retryAfterSeconds ?? 0) * 1000));
    }
  }

  private blockedError(until: number, status?: number): DeckSourceError {
    const retryAfterSeconds = retryAfterSecondsUntil(until, this.now());
    return this.error(
      'blocked',
      'Moxfield is blocking server-side requests (bot protection); server fetches are paused. Use browser capture instead.',
      status === undefined ? { retryAfterSeconds } : { status, retryAfterSeconds },
    );
  }

  private rateLimitedError(until: number, status?: number): DeckSourceError {
    const retryAfterSeconds = retryAfterSecondsUntil(until, this.now());
    return this.error(
      'rate-limited',
      'Moxfield is rate limiting requests; try again later.',
      status === undefined ? { retryAfterSeconds } : { status, retryAfterSeconds },
    );
  }

  /** Waits until `minRequestIntervalMs` has passed since the previous request started. */
  private async throttle(): Promise<void> {
    if (this.lastRequestStart !== null) {
      const wait = this.lastRequestStart + this.minRequestIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
    }
    this.lastRequestStart = this.now();
  }

  private failure(
    code: DeckSourceErrorCode,
    message: string,
    extra: { status?: number; retryAfterSeconds?: number; cause?: unknown } = {},
    retryable = false,
  ): Failure {
    return { error: this.error(code, message, extra), retryable };
  }

  private async attempt(path: string, signal: AbortSignal | undefined): Promise<{ body: unknown } | Failure> {
    const blockedUntil = this.blockedUntil();
    if (blockedUntil !== null) return { error: this.blockedError(blockedUntil), retryable: false };
    const rateLimitedUntil = this.rateLimitedUntil();
    if (rateLimitedUntil !== null) {
      return { error: this.rateLimitedError(rateLimitedUntil), retryable: false };
    }
    signal?.throwIfAborted();
    await this.throttle();
    signal?.throwIfAborted();

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': this.userAgent },
        // Never follow redirects: only the configured API host is ever contacted.
        redirect: 'manual',
        signal: combined,
      });
      this.logger?.debug('Moxfield response', { path, status: response.status });
      return await this.handleResponse(response);
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason;
      if (timeout.aborted) {
        return this.failure('timeout', `Moxfield did not answer within ${this.timeoutMs} ms.`, {
          cause: error,
        });
      }
      return this.failure('network', 'Could not reach Moxfield (network error).', { cause: error }, true);
    }
  }

  private async handleResponse(response: Response): Promise<{ body: unknown } | Failure> {
    const { status } = response;
    const contentType = response.headers.get('content-type') ?? '';
    const isJson = isJsonContentType(contentType);

    if (response.ok) {
      if (contentType !== '' && !isJson) {
        await discardBody(response);
        return this.failure('schema', `Moxfield answered with ${contentType} instead of JSON.`, { status });
      }
      if (Number(response.headers.get('content-length') ?? '0') > MAX_RESPONSE_BYTES) {
        await discardBody(response);
        return this.failure('schema', 'The Moxfield response is too large.', { status });
      }
      // Counted while reading: a chunked or understated response is not buffered whole.
      const bytes =
        response.body === null
          ? new Uint8Array()
          : await readStreamLimited(response.body, MAX_RESPONSE_BYTES);
      if (bytes === null) {
        return this.failure('schema', 'The Moxfield response is too large.', { status });
      }
      try {
        return { body: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
      } catch (cause) {
        return this.failure('schema', 'Moxfield answered with invalid JSON.', { status, cause });
      }
    }

    await discardBody(response);
    if (isBotProtectionBlock(response, contentType, isJson)) {
      const until = this.now() + this.blockBackoffMs;
      this.blockedUntilMs = until;
      return { error: this.blockedError(until, status), retryable: false };
    }
    if (status === 404 || status === 410) {
      return this.failure('not-found', 'The deck does not exist on Moxfield (deleted or wrong id).', {
        status,
      });
    }
    if (status === 401 || status === 403) {
      return this.failure(
        'forbidden',
        'The deck is private or not accessible without signing in to Moxfield.',
        {
          status,
        },
      );
    }
    if (status === 429) {
      // Honor Retry-After for every later request; the block backoff caps an absurd value.
      const retryAfterSeconds =
        parseRetryAfter(response.headers.get('retry-after'), this.now()) ?? DEFAULT_RATE_LIMIT_PAUSE_SECONDS;
      const until = this.now() + Math.min(retryAfterSeconds * 1000, this.blockBackoffMs);
      this.rateLimitedUntilMs = Math.max(this.rateLimitedUntilMs ?? 0, until);
      return { error: this.rateLimitedError(until, status), retryable: false };
    }
    const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'), this.now());
    const retryable =
      status >= 500 && (retryAfterSeconds === undefined || retryAfterSeconds <= MAX_RETRY_AFTER_SECONDS);
    return this.failure(
      'unavailable',
      `Moxfield answered HTTP ${status}.`,
      retryAfterSeconds === undefined ? { status } : { status, retryAfterSeconds },
      retryable,
    );
  }
}
