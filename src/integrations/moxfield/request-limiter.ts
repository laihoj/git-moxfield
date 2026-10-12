/**
 * What the Moxfield HTTP client needs from the app to stay within Moxfield's terms: at most
 * one API call per second, from every server of the installation together (ADR 0009).
 *
 * The client asks {@link MoxfieldRequestLimiter.admit} before EVERY request it sends (deck,
 * primer, and each retry) and reports a 429 or a refusal, so that every instance slows down
 * or stops together. The app implements it on the shared database
 * (`src/server/moxfield-limiter.ts`); this directory never touches the database itself.
 */
import type { ServerFetchStatus } from '../deck-source';

/** The limiter's view of server fetching (configuration can still turn it off). */
export type LimiterStatus = Exclude<ServerFetchStatus, { state: 'disabled' }>;

export interface MoxfieldRequestLimiter {
  /**
   * Waits for this request's slot. Resolves when the request may be sent right away.
   * Fails closed: rejects, and the request must not be sent, when server fetching is
   * paused, backing off after a 429, too busy (the slot is too far away), or the limiter
   * cannot tell (its database is unreachable).
   *
   * @throws {DeckSourceError} `blocked`, `rate-limited` or `unavailable`.
   * A `signal` aborted by the caller rejects with the signal's reason instead.
   */
  admit(signal?: AbortSignal): Promise<void>;
  /**
   * Moxfield answered 429: every instance waits (for `retryAfterSeconds` when Moxfield sent
   * it, else an exponential backoff), then runs at half speed for a while.
   * @returns seconds until requests resume. Never throws.
   */
  rateLimited(retryAfterSeconds: number | undefined): Promise<number>;
  /**
   * Moxfield refused (403) or challenged a request: pauses server fetching for every
   * instance until an operator resumes it. Never throws.
   */
  blocked(reason: string): Promise<void>;
  /** The shared state, for status displays. */
  status(): Promise<LimiterStatus>;
  /** Ends a pause (an operator's action). @returns whether server fetching was paused. */
  resume(): Promise<boolean>;
}
