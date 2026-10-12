/**
 * A clock that only moves when told to, for tests and for the demo seed (an operator
 * script that fakes ten weeks of history). Free of test-runner imports, so scripts can use it.
 */

const DEFAULT_START = '2026-10-09T12:00:00.000Z';

export class ManualClock {
  private ms: number;

  /** @param start an ISO timestamp, or milliseconds since the epoch. */
  constructor(start: string | number = DEFAULT_START) {
    this.ms = typeof start === 'number' ? start : Date.parse(start);
  }

  readonly now = (): Date => new Date(this.ms);

  readonly epochMs = (): number => this.ms;

  /** Moves the clock to `ms` milliseconds since the epoch. */
  set(ms: number): void {
    this.ms = ms;
  }

  /** Moves the clock forward by `ms` milliseconds. */
  advanceMs(ms: number): void {
    this.ms += ms;
  }

  /** Moves the clock forward by `seconds`. */
  advance(seconds: number): void {
    this.advanceMs(seconds * 1000);
  }

  iso(): string {
    return new Date(this.ms).toISOString();
  }
}
