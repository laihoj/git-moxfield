/**
 * Server-side HTTP client for Moxfield's (private) API: the ONLY code that sends requests
 * to it (a test fails when another module does; `tests/integration/moxfield-choke-point.test.ts`).
 *
 * Polite by construction: every request (deck, primer, and each retry) first waits for its
 * slot from the installation-wide {@link MoxfieldRequestLimiter} (ADR 0009), which keeps
 * every server instance together under Moxfield's limit of one call per second, and is not
 * sent when the limiter refuses or cannot answer. A 429 slows every instance down, and a
 * 403 or a bot-protection challenge pauses server fetching for every instance until an
 * operator resumes it. The User-Agent is honest (never a spoofed browser) and never logged;
 * only URLs built from the configured API base and validated ids are requested.
 */
import { parseHttpUrl, stripTrailingSlashes } from '@/core/http-url';
import type { Logger } from '@/core/logger';
import { readStreamLimited } from '@/core/streams';

import { retryAfterSecondsUntil, type DeckSourceError, type DeckSourceErrorCode } from '../deck-source';

import {
  DEFAULT_MOXFIELD_USER_AGENT,
  MOXFIELD_INTERNAL_ID_PATTERN,
  moxfieldDeckApiPath,
  moxfieldPrimerApiPath,
} from './constants';
import { moxfieldError } from './errors';
import type { MoxfieldRequestLimiter } from './request-limiter';
import { isValidMoxfieldPublicId } from './url';

export interface MoxfieldHttpClientOptions {
  /** API base URL, e.g. `https://api2.moxfield.com` (a path prefix is allowed). */
  apiBaseUrl: string;
  /** Moxfield-issued User-Agent. Defaults to the honest `git-moxfield/<version>` one. Never logged. */
  userAgent?: string;
  /** Per-attempt timeout, covering the response body. */
  timeoutMs: number;
  /** Admits every request (required: there is no unlimited client). */
  limiter: MoxfieldRequestLimiter;
  fetchImpl?: typeof fetch;
  /** Clock in epoch milliseconds, for HTTP-date `Retry-After` values. Defaults to `Date.now`. */
  now?: () => number;
  /** Delay before a retry. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

/** Delay before the single retry of a 5xx or network failure. */
const RETRY_DELAY_MS = 1_000;

/**
 * Longest `Retry-After` of a 5xx answer that is still waited for before the single
 * retry. Longer outages are reported right away instead of holding the request.
 */
const MAX_RETRY_AFTER_SECONDS = 5;

/** Generous safety cap for a response body (a large deck is a few MB). */
const MAX_RESPONSE_BYTES = 16_000_000;

const PAUSED_HINT =
  'Server fetching is paused for everyone until an admin resumes it. Use the bookmarklet meanwhile.';

const BLOCKED_MESSAGE = `Moxfield's bot protection blocked a server-side request. ${PAUSED_HINT}`;

const REFUSED_MESSAGE = `Moxfield refused a server-side request (HTTP 403): the deck may be private, or Moxfield may be refusing this app. ${PAUSED_HINT}`;

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
 * Whether a response is bot protection rather than an API answer: Cloudflare marks its
 * challenge interstitials with `cf-mitigated: challenge` (at any status), and its block
 * pages are a 403 with an HTML (or, behind Cloudflare, any non-JSON) body. A successful
 * answer in HTML is never the API either. Other statuses, notably a 503 maintenance or
 * overload page served through Cloudflare, are outages, not blocks.
 */
function isBotProtection(response: Response, contentType: string, isJson: boolean): boolean {
  if (response.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge') return true;
  if (isJson) return false;
  const html = /\btext\/html\b/i.test(contentType);
  if (response.ok) return html;
  return response.status === 403 && (html || response.headers.has('cf-ray'));
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
  private readonly limiter: MoxfieldRequestLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Logger | undefined;

  /** @throws {TypeError} when `apiBaseUrl` is not an absolute http(s) URL. */
  constructor(options: MoxfieldHttpClientOptions) {
    const base = parseHttpUrl(options.apiBaseUrl);
    if (base === null) throw new TypeError('Moxfield apiBaseUrl must be an absolute http(s) URL');
    this.baseUrl = `${base.origin}${stripTrailingSlashes(base.pathname)}`;
    this.userAgent = options.userAgent ?? DEFAULT_MOXFIELD_USER_AGENT;
    this.timeoutMs = options.timeoutMs;
    this.limiter = options.limiter;
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
        moxfieldError('invalid-ref', `Invalid Moxfield deck id: ${JSON.stringify(publicId)}`),
      );
    }
    return this.request(moxfieldDeckApiPath(publicId), signal);
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
        moxfieldError('schema', `Invalid Moxfield internal deck id: ${JSON.stringify(internalId)}`),
      );
    }
    return this.request(moxfieldPrimerApiPath(internalId), signal);
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

  private failure(
    code: DeckSourceErrorCode,
    message: string,
    extra: { status?: number; retryAfterSeconds?: number; cause?: unknown } = {},
    retryable = false,
  ): Failure {
    return { error: moxfieldError(code, message, extra), retryable };
  }

  private async attempt(path: string, signal: AbortSignal | undefined): Promise<{ body: unknown } | Failure> {
    signal?.throwIfAborted();
    // Rejects (and nothing is sent) unless every instance together stays within the limit.
    await this.limiter.admit(signal);
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
      return await this.handleResponse(path, response);
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

  private async handleResponse(path: string, response: Response): Promise<{ body: unknown } | Failure> {
    const { status } = response;
    const contentType = response.headers.get('content-type') ?? '';
    const isJson = isJsonContentType(contentType);

    if (isBotProtection(response, contentType, isJson)) {
      await discardBody(response);
      const mediaType = contentType.split(';')[0]?.trim() ?? '';
      await this.limiter.blocked(
        `Moxfield's bot protection answered a request (HTTP ${status}, ${mediaType === '' ? 'no content type' : mediaType}${response.headers.has('cf-mitigated') ? ', challenge' : ''}).`,
      );
      return this.failure('blocked', BLOCKED_MESSAGE, { status });
    }
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
    if (status === 429) {
      // Every instance waits (Retry-After, else an exponential backoff), then slows down.
      const retryAfterSeconds = await this.limiter.rateLimited(
        parseRetryAfter(response.headers.get('retry-after'), this.now()),
      );
      return this.failure(
        'rate-limited',
        `Moxfield asked git-moxfield to slow down (HTTP 429). Server fetches wait ${retryAfterSeconds} s, then run at half speed for a while.`,
        { status, retryAfterSeconds },
      );
    }
    if (status === 403) {
      // A refusal may be the start of a ban (Moxfield answers 429 first): stop everything.
      await this.limiter.blocked(`Moxfield refused a request (HTTP 403) for ${path}.`);
      return this.failure('blocked', REFUSED_MESSAGE, { status });
    }
    if (status === 404 || status === 410) {
      return this.failure('not-found', 'The deck does not exist on Moxfield (deleted or wrong id).', {
        status,
      });
    }
    if (status === 401) {
      return this.failure(
        'forbidden',
        'The deck is private or not accessible without signing in to Moxfield.',
        { status },
      );
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
