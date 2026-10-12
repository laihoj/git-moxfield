/**
 * The installation-wide limiter of server-side requests to Moxfield (ADR 0009): the
 * {@link MoxfieldRequestLimiter} the Moxfield HTTP client asks before every request, on the
 * database every process and serverless function instance shares.
 *
 * Moxfield's terms for the issued User-Agent: at most one API call per second. Netlify runs
 * an unknown number of function instances, so a per-process throttle cannot keep that
 * promise; one row in the database can. For each request:
 *
 * 1. **Reserve** the next slot with one atomic statement that reads the database's clock
 *    (`moxfield_rate`, see `repositories/moxfield-rate.ts`). Slots are `intervalMs` apart
 *    (doubled while slowed down after a 429), in the database's time, so instance clocks
 *    never matter.
 * 2. **Wait** `slot - dbNow`, measured with this process's monotonic clock from before the
 *    reservation was sent, so the request never starts before its slot.
 * 3. **Re-check** after waiting (one read): a 429 or a pause that arrived meanwhile cancels
 *    the request.
 * 4. **Start only on time**: the request may start late (a slow database answer, a busy
 *    event loop), which would bring it closer to the next one. When it might be late by
 *    more than `interval - 1250 ms`, the slot is given up and a new one reserved.
 *
 * Fails closed: when the database cannot be reached or answers unexpectedly, nothing is
 * sent to Moxfield. A slot further away than `maxWaitMs` is refused ("busy, try again").
 */
import 'server-only';

import type { DeckSourceError } from '@/integrations/deck-source';
import { MOXFIELD_MIN_SPACING_MS, MOXFIELD_START_MARGIN_MS } from '@/integrations/moxfield/constants';
import { moxfieldError } from '@/integrations/moxfield/errors';
import type { LimiterStatus, MoxfieldRequestLimiter } from '@/integrations/moxfield/request-limiter';
import {
  createRepositories,
  type LibsqlExecutor,
  type MoxfieldRateRepository,
  type MoxfieldRateState,
} from '@/server/repositories';

import type { Logger } from './logger';

/** Longest wait for a slot; a request that would wait longer fails as busy. */
export const DEFAULT_MAX_WAIT_MS = 10_000;

/** Pause after a 429 without `Retry-After`; doubles with each 429 in a row. */
export const DEFAULT_BASE_BACKOFF_MS = 30_000;

/** Longest pause after a 429 without `Retry-After`. */
export const DEFAULT_MAX_BACKOFF_MS = 15 * 60_000;

/** Longest `Retry-After` honored as given (a sanity cap against absurd values). */
export const DEFAULT_MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;

/** How long after a 429's pause the interval stays doubled (the quiet period before recovery). */
export const DEFAULT_SLOW_PERIOD_MS = 10 * 60_000;

/** Reservations per request before giving up when every slot would start too late. */
const MAX_RESERVATIONS = 3;

export interface DatabaseMoxfieldLimiterOptions {
  /** The database every instance shares (the app's `getDb`). Its failures fail closed. */
  db: () => Promise<LibsqlExecutor>;
  /** Spacing between the starts of two requests of the whole installation. */
  intervalMs: number;
  maxWaitMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxRetryAfterMs?: number;
  slowPeriodMs?: number;
  /** Monotonic clock in ms, for waiting. Default: `performance.now`. Its offset never matters. */
  clock?: () => number;
  /** Waits `ms`; rejects with the signal's reason when it aborts. Default: `setTimeout`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  logger: Logger;
}

/** What the Admin page shows about the limiter. */
export interface MoxfieldLimiterDetails {
  status: LimiterStatus;
  /** The configured interval. */
  intervalMs: number;
  /** The interval in force now (doubled while slowed down after a 429). */
  currentIntervalMs: number;
  /** Until when the interval is doubled; `null` when it is not. */
  slowedUntil: string | null;
  lastRateLimitedAt: string | null;
  rateLimitCount: number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function secondsUntil(untilMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((untilMs - nowMs) / 1000));
}

const RESUME_HINT = 'An admin can resume it on the Admin page. Use the bookmarklet meanwhile.';

const RATE_LIMITED_REASON =
  'Moxfield asked git-moxfield to slow down (HTTP 429), so every server fetch waits.';

/** Why requests are refused right now (pause, then 429 backoff), or `null` when they are not. */
function refusal(state: MoxfieldRateState): DeckSourceError | null {
  if (state.pausedAtMs !== null) {
    return moxfieldError(
      'blocked',
      `Server fetching from Moxfield is paused: ${state.pauseReason ?? ''} ${RESUME_HINT}`,
    );
  }
  if (state.backoffUntilMs > state.nowMs) {
    const retryAfterSeconds = secondsUntil(state.backoffUntilMs, state.nowMs);
    return moxfieldError('rate-limited', `${RATE_LIMITED_REASON} Try again in ${retryAfterSeconds} s.`, {
      retryAfterSeconds,
    });
  }
  return null;
}

function busy(retryAfterSeconds: number): DeckSourceError {
  return moxfieldError(
    'rate-limited',
    `Other requests to Moxfield are queued ahead of this one (at most one per second for this whole app). Try again in ${retryAfterSeconds} s.`,
    { retryAfterSeconds },
  );
}

export class DatabaseMoxfieldLimiter implements MoxfieldRequestLimiter {
  readonly intervalMs: number;
  private readonly db: () => Promise<LibsqlExecutor>;
  private readonly maxWaitMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly slowPeriodMs: number;
  private readonly clock: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly logger: Logger;
  private readonly repositories = new WeakMap<LibsqlExecutor, MoxfieldRateRepository>();

  /** @throws {RangeError} for a negative interval. */
  constructor(options: DatabaseMoxfieldLimiterOptions) {
    if (!(options.intervalMs >= 0)) throw new RangeError('intervalMs must be a non-negative number');
    this.intervalMs = options.intervalMs;
    this.db = options.db;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
    this.slowPeriodMs = options.slowPeriodMs ?? DEFAULT_SLOW_PERIOD_MS;
    this.clock = options.clock ?? (() => performance.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.logger = options.logger;
  }

  async admit(signal?: AbortSignal): Promise<void> {
    let retryAfterSeconds = 1;
    for (let reservation = 1; reservation <= MAX_RESERVATIONS; reservation++) {
      signal?.throwIfAborted();
      const sentAt = this.clock();
      const granted = await this.guarded('reserve a request slot', (repo) =>
        repo.reserve({ intervalMs: this.intervalMs, maxWaitMs: this.maxWaitMs }),
      );
      if (!granted.granted) {
        const { state } = granted;
        const refused = refusal(state);
        if (refused !== null) throw refused;
        const slotMs = Math.max(state.nowMs, state.nextSlotMs, state.backoffUntilMs);
        throw busy(secondsUntil(slotMs - this.maxWaitMs, state.nowMs));
      }
      const waitMs = granted.slotMs - granted.nowMs;
      if (waitMs > 0) {
        await this.sleep(waitMs, signal);
        // A 429 or a pause may have arrived while this request waited for its slot.
        const state = await this.guarded('check the request limiter', (repo) => repo.state());
        if (state.pausedAtMs !== null || state.backoffUntilMs > granted.slotMs) {
          throw refusal(state) ?? busy(1);
        }
      }
      // The slot began between sending the reservation and its answer (database time), so
      // this is how late, at most, the request starts compared to its slot.
      const latenessMs = this.clock() - (sentAt + waitMs);
      const allowedLatenessMs = granted.intervalMs - MOXFIELD_MIN_SPACING_MS - MOXFIELD_START_MARGIN_MS;
      // An interval that short is only allowed against a stand-in for Moxfield (tests).
      if (allowedLatenessMs < 0 || latenessMs <= allowedLatenessMs) return;
      this.logger.warn('A Moxfield request slot passed before the request could start; reserving another', {
        latenessMs: Math.round(latenessMs),
        intervalMs: granted.intervalMs,
        reservation,
      });
      retryAfterSeconds = secondsUntil(granted.slotMs + granted.intervalMs, granted.nowMs);
    }
    throw busy(retryAfterSeconds);
  }

  async rateLimited(retryAfterSeconds: number | undefined): Promise<number> {
    try {
      const repo = await this.repository();
      const state = await repo.recordRateLimit({
        retryAfterMs: retryAfterSeconds === undefined ? null : retryAfterSeconds * 1000,
        baseBackoffMs: this.baseBackoffMs,
        maxBackoffMs: this.maxBackoffMs,
        maxRetryAfterMs: this.maxRetryAfterMs,
        slowPeriodMs: this.slowPeriodMs,
      });
      this.logger.warn('Moxfield answered 429: every server fetch waits, then runs at half speed', {
        retryAfterSeconds: retryAfterSeconds ?? null,
        backoffLevel: state.backoffLevel,
        resumesAt: iso(state.backoffUntilMs),
        slowedUntil: iso(state.slowUntilMs),
      });
      return secondsUntil(state.backoffUntilMs, state.nowMs);
    } catch (error) {
      // Nothing more can be done here: the next reservation needs the database as well.
      this.logger.error('Could not record a Moxfield 429 in the request limiter', { error });
      return Math.ceil((retryAfterSeconds ?? this.baseBackoffMs / 1000) || 1);
    }
  }

  async blocked(reason: string): Promise<void> {
    try {
      const repo = await this.repository();
      const state = await repo.pause(reason);
      this.logger.error(
        'Moxfield refused a server-side request: server fetching is paused until an admin resumes it',
        {
          reason,
          pausedAt: state.pausedAtMs === null ? null : iso(state.pausedAtMs),
        },
      );
    } catch (error) {
      this.logger.error('Could not pause server fetching after Moxfield refused a request', {
        reason,
        error,
      });
    }
  }

  async status(): Promise<LimiterStatus> {
    return toStatus(await (await this.repository()).state());
  }

  async details(): Promise<MoxfieldLimiterDetails> {
    const state = await (await this.repository()).state();
    const slowed = state.slowUntilMs > state.nowMs;
    return {
      status: toStatus(state),
      intervalMs: this.intervalMs,
      currentIntervalMs: slowed ? 2 * this.intervalMs : this.intervalMs,
      slowedUntil: slowed ? iso(state.slowUntilMs) : null,
      lastRateLimitedAt: state.lastRateLimitedMs === null ? null : iso(state.lastRateLimitedMs),
      rateLimitCount: state.rateLimitCount,
    };
  }

  async resume(): Promise<boolean> {
    const repo = await this.repository();
    const before = await repo.state();
    await repo.resume();
    if (before.pausedAtMs !== null) {
      this.logger.info('Server fetching from Moxfield resumed', { pausedSince: iso(before.pausedAtMs) });
    }
    return before.pausedAtMs !== null;
  }

  /** Forgets every pause, backoff and reserved slot: the end-to-end suite's reset only. */
  async reset(): Promise<void> {
    await (await this.repository()).reset();
  }

  private async repository(): Promise<MoxfieldRateRepository> {
    const db = await this.db();
    let repo = this.repositories.get(db);
    if (repo === undefined) {
      repo = createRepositories(db).moxfieldRate;
      this.repositories.set(db, repo);
    }
    return repo;
  }

  /** Runs `operation` on the limiter's table; any failure means no request (`unavailable`). */
  private async guarded<T>(
    what: string,
    operation: (repo: MoxfieldRateRepository) => Promise<T>,
  ): Promise<T> {
    try {
      return await operation(await this.repository());
    } catch (error) {
      this.logger.error(`Could not ${what}; nothing was sent to Moxfield`, { error });
      throw moxfieldError(
        'unavailable',
        'git-moxfield could not check its limit on requests to Moxfield (database unavailable), so nothing was sent. Try again in a moment.',
        { cause: error },
      );
    }
  }
}

function toStatus(state: MoxfieldRateState): LimiterStatus {
  if (state.pausedAtMs !== null) {
    return {
      state: 'paused',
      reason: state.pauseReason ?? 'Moxfield refused a server-side request.',
      pausedAt: iso(state.pausedAtMs),
    };
  }
  if (state.backoffUntilMs > state.nowMs) {
    return { state: 'rate-limited', reason: RATE_LIMITED_REASON, retryAt: iso(state.backoffUntilMs) };
  }
  return { state: 'available' };
}
