/**
 * The installation-wide limiter of server-side requests to Moxfield (ADR 0009): one row of
 * `moxfield_rate`, shared by every process and serverless function instance that uses the
 * database.
 *
 * Every method is ONE statement, so the database orders them and none can interleave with
 * another instance's: a reservation reads the database's own clock and advances the next
 * free slot in the same `UPDATE ... RETURNING`. All times are epoch milliseconds of the
 * database's clock ({@link DB_NOW_MS}); an instance's clock is never stored or compared, so
 * clock skew between instances cannot bring two requests closer than the interval.
 * SQLite evaluates `'now'` once per statement, so every use of it in one statement sees the
 * same instant.
 *
 * Installation-wide like settings: the bound workspace does not affect it.
 */
import { eq, sql, type SQL } from 'drizzle-orm';
import type { SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core';

import { moxfieldRate } from '@/server/db/schema';

import { write, type RepositoryContext } from './context';

/** The limiter's only row (created by migration 0010). */
const ROW_ID = 1;

/** The database's clock in whole epoch milliseconds (`unixepoch('subsec')` has millisecond resolution). */
export const DB_NOW_MS: SQL<number> = sql<number>`CAST(round(unixepoch('subsec') * 1000) AS INTEGER)`;

/** The limiter row as read, with the database's clock at the time of the statement. */
export interface MoxfieldRateState {
  /** The database's clock when the statement ran. */
  nowMs: number;
  /** The earliest time the next request may start. */
  nextSlotMs: number;
  /** After a 429: no request starts before this time. */
  backoffUntilMs: number;
  /** 429s in a row (exponential backoff). */
  backoffLevel: number;
  /** Until this time the interval between requests is doubled. */
  slowUntilMs: number;
  lastRateLimitedMs: number | null;
  rateLimitCount: number;
  /** When server fetching was paused (until an operator resumes it); `null` when it is not. */
  pausedAtMs: number | null;
  pauseReason: string | null;
}

export type MoxfieldReservation =
  /** A request may start at `slotMs` (database clock): `slotMs - nowMs` from now. */
  | { granted: true; slotMs: number; nowMs: number; intervalMs: number }
  /** Refused: paused, backing off after a 429, or the next free slot is too far away. */
  | { granted: false; state: MoxfieldRateState };

export interface ReserveOptions {
  /** Spacing between the starts of two requests (doubled while slowed down after a 429). */
  intervalMs: number;
  /** Refuse instead of granting a slot more than this far in the future. */
  maxWaitMs: number;
}

export interface RecordRateLimitOptions {
  /** Moxfield's `Retry-After`, when it sent a usable one. */
  retryAfterMs: number | null;
  /** The pause after a 429 without `Retry-After`; doubles with each 429 in a row. */
  baseBackoffMs: number;
  /** The longest pause without `Retry-After`. */
  maxBackoffMs: number;
  /** The longest pause a `Retry-After` can ask for (a sanity cap). */
  maxRetryAfterMs: number;
  /** How long after the pause the interval stays doubled; a 429 within it continues the series. */
  slowPeriodMs: number;
}

export interface MoxfieldRateRepository {
  /**
   * Reserves the next request slot, atomically for every instance: the slot is the latest
   * of now, the next free slot and the end of a 429 backoff, and the next free slot moves
   * one interval past it. Refused (nothing reserved) when server fetching is paused or the
   * slot is more than `maxWaitMs` away.
   * @throws when the database fails or the limiter row is missing.
   */
  reserve(options: ReserveOptions): Promise<MoxfieldReservation>;
  /** Records a 429: every instance waits, then runs at half speed for a while. */
  recordRateLimit(options: RecordRateLimitOptions): Promise<MoxfieldRateState>;
  /** Pauses server fetching until {@link resume}. Keeps the reason and time of a pause in progress. */
  pause(reason: string): Promise<MoxfieldRateState>;
  /** Ends a pause; a 429 backoff and slowdown keep running. */
  resume(): Promise<MoxfieldRateState>;
  /** Forgets everything: pauses, backoffs, slowdowns, slots and 429 counts (the end-to-end suite's reset only). */
  reset(): Promise<MoxfieldRateState>;
  state(): Promise<MoxfieldRateState>;
}

const t = moxfieldRate;

/** Every column of the row, and the database's clock, for `RETURNING` and `SELECT`. */
const STATE_COLUMNS = {
  nowMs: DB_NOW_MS,
  nextSlotMs: t.nextSlotMs,
  backoffUntilMs: t.backoffUntilMs,
  backoffLevel: t.backoffLevel,
  slowUntilMs: t.slowUntilMs,
  lastRateLimitedMs: t.lastRateLimitedMs,
  rateLimitCount: t.rateLimitCount,
  pausedAtMs: t.pausedAtMs,
  pauseReason: t.pauseReason,
};

function missingRow(): Error {
  return new Error('The Moxfield rate limiter row is missing (run pnpm db:migrate)');
}

function only<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (row === undefined) throw missingRow();
  return row;
}

export function createMoxfieldRateRepository(ctx: RepositoryContext): MoxfieldRateRepository {
  const updateRow = (set: SQLiteUpdateSetSource<typeof t>) =>
    write(ctx, (db) => db.update(t).set(set).where(eq(t.id, ROW_ID)).returning(STATE_COLUMNS)).then(only);

  return {
    async reserve({ intervalMs, maxWaitMs }) {
      // In SET every column reference is the row before this statement.
      const start = sql`max(${DB_NOW_MS}, ${t.nextSlotMs}, ${t.backoffUntilMs})`;
      const interval = sql`(CASE WHEN ${DB_NOW_MS} < ${t.slowUntilMs} THEN 2 * ${intervalMs} ELSE ${intervalMs} END)`;
      const allowed = sql`(${t.pausedAtMs} IS NULL AND ${start} - ${DB_NOW_MS} <= ${maxWaitMs})`;
      const row = await write(ctx, (db) =>
        db
          .update(t)
          .set({
            nextSlotMs: sql`CASE WHEN ${allowed} THEN ${start} + ${interval} ELSE ${t.nextSlotMs} END`,
            lastGrantMs: sql`CASE WHEN ${allowed} THEN ${start} ELSE NULL END`,
          })
          .where(eq(t.id, ROW_ID))
          .returning({ ...STATE_COLUMNS, lastGrantMs: t.lastGrantMs }),
      ).then(only);
      const { lastGrantMs, ...state } = row;
      if (lastGrantMs === null) return { granted: false, state };
      return {
        granted: true,
        slotMs: lastGrantMs,
        nowMs: state.nowMs,
        intervalMs: state.nextSlotMs - lastGrantMs,
      };
    },

    recordRateLimit(options) {
      // A 429 within the slow period of the previous one continues the series.
      const level = sql`(CASE WHEN ${DB_NOW_MS} < ${t.slowUntilMs} THEN min(${t.backoffLevel} + 1, 30) ELSE 1 END)`;
      const pause =
        options.retryAfterMs === null
          ? sql`min(${options.baseBackoffMs} * (1 << (${level} - 1)), ${options.maxBackoffMs})`
          : sql`${Math.min(Math.max(0, options.retryAfterMs), options.maxRetryAfterMs)}`;
      return updateRow({
        backoffLevel: level,
        backoffUntilMs: sql`max(${t.backoffUntilMs}, ${DB_NOW_MS} + ${pause})`,
        slowUntilMs: sql`max(${t.slowUntilMs}, ${DB_NOW_MS} + ${pause} + ${options.slowPeriodMs})`,
        lastRateLimitedMs: DB_NOW_MS,
        rateLimitCount: sql`${t.rateLimitCount} + 1`,
      });
    },

    pause(reason) {
      return updateRow({
        pauseReason: sql`CASE WHEN ${t.pausedAtMs} IS NULL THEN ${reason} ELSE ${t.pauseReason} END`,
        pausedAtMs: sql`coalesce(${t.pausedAtMs}, ${DB_NOW_MS})`,
      });
    },

    resume() {
      return updateRow({ pausedAtMs: null, pauseReason: null });
    },

    reset() {
      return updateRow({
        nextSlotMs: 0,
        lastGrantMs: null,
        backoffUntilMs: 0,
        backoffLevel: 0,
        slowUntilMs: 0,
        lastRateLimitedMs: null,
        rateLimitCount: 0,
        pausedAtMs: null,
        pauseReason: null,
      });
    },

    async state() {
      const row = await ctx.db.select(STATE_COLUMNS).from(t).where(eq(t.id, ROW_ID)).get();
      if (row === undefined) throw missingRow();
      return row;
    },
  };
}
