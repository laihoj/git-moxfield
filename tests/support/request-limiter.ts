/**
 * An in-memory {@link MoxfieldRequestLimiter} for unit tests of the Moxfield HTTP client and
 * deck source: it admits every request unless told otherwise, and records what the client
 * reported. The real limiter (`src/server/moxfield-limiter.ts`) is tested on databases.
 */
import type { DeckSourceError } from '@/integrations/deck-source';
import { moxfieldError } from '@/integrations/moxfield/errors';
import type { LimiterStatus, MoxfieldRequestLimiter } from '@/integrations/moxfield/request-limiter';

export class FakeMoxfieldLimiter implements MoxfieldRequestLimiter {
  /** Requests admitted, in order (one per request the client may send). */
  admitted = 0;
  /** `retryAfterSeconds` of every 429 reported. */
  readonly rateLimits: (number | undefined)[] = [];
  /** Reasons of every refusal reported. */
  readonly blocks: string[] = [];
  /** When set, `admit` rejects with it (and admits nothing). */
  refuseWith: DeckSourceError | null = null;
  /** What `rateLimited` answers when Moxfield sent no `Retry-After`. */
  backoffSeconds = 30;
  private pausedReason: string | null = null;

  admit(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.pausedReason !== null) {
      return Promise.reject(
        moxfieldError('blocked', `Server fetching from Moxfield is paused: ${this.pausedReason}`),
      );
    }
    if (this.refuseWith !== null) return Promise.reject(this.refuseWith);
    this.admitted += 1;
    return Promise.resolve();
  }

  rateLimited(retryAfterSeconds: number | undefined): Promise<number> {
    this.rateLimits.push(retryAfterSeconds);
    return Promise.resolve(retryAfterSeconds ?? this.backoffSeconds);
  }

  blocked(reason: string): Promise<void> {
    this.blocks.push(reason);
    this.pausedReason ??= reason;
    return Promise.resolve();
  }

  status(): Promise<LimiterStatus> {
    return Promise.resolve(
      this.pausedReason === null
        ? { state: 'available' }
        : { state: 'paused', reason: this.pausedReason, pausedAt: '2026-10-09T12:00:00.000Z' },
    );
  }

  resume(): Promise<boolean> {
    const wasPaused = this.pausedReason !== null;
    this.pausedReason = null;
    return Promise.resolve(wasPaused);
  }
}
