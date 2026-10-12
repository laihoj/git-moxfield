/**
 * The installation-wide Moxfield request limiter (ADR 0009) on a real database: several
 * "instances" (connections of their own, clocks skewed by hours) never start two requests
 * closer than the interval, a 429 slows every instance down and recovers on its own, a 403
 * pauses every instance until resumed, and any database failure means no request at all.
 *
 * These run in real time against the database's own clock (which tests cannot move), with
 * short backoffs. `tests/remote/moxfield-rate.test.ts` repeats the concurrency check with
 * separate processes against a libSQL server.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { DeckSourceError } from '@/integrations/deck-source';
import {
  DEFAULT_MOXFIELD_REQUEST_INTERVAL_MS,
  MIN_MOXFIELD_REQUEST_INTERVAL_MS,
  MOXFIELD_MIN_SPACING_MS,
  MOXFIELD_START_MARGIN_MS,
} from '@/integrations/moxfield/constants';
import { MoxfieldHttpClient } from '@/integrations/moxfield/http-client';
import { jsonResponse, fakeFetch } from '@/integrations/moxfield/test-fixtures';
import type { LibsqlDb } from '@/server/db/libsql';
import { DatabaseMoxfieldLimiter, type DatabaseMoxfieldLimiterOptions } from '@/server/moxfield-limiter';
import { createRepositories } from '@/server/repositories';
import { openTestDatabaseHandle } from '@tests/support/db';
import { expectRejection } from '@tests/support/errors';
import { scratchFileUrl } from '@tests/support/libsql';
import { admitSequentially, preciseNow, skewedClock, startSpacing } from '@tests/support/moxfield-rate';
import { recordingLogger } from '@tests/support/recording-logger';

const HOUR_MS = 3_600_000;

/** `count` connections of their own to one new database file: instances sharing a database. */
async function sharedDatabase(count: number): Promise<LibsqlDb[]> {
  const url = scratchFileUrl('moxfield-rate.db');
  const handles = [];
  for (let index = 0; index < count; index++) handles.push(await openTestDatabaseHandle({ url }));
  return handles.map((handle) => handle.db);
}

async function oneDatabase(): Promise<LibsqlDb> {
  const [db] = await sharedDatabase(1);
  if (db === undefined) throw new Error('No database');
  return db;
}

/** Two instances' connections to one database. */
async function twoDatabases(): Promise<[LibsqlDb, LibsqlDb]> {
  const [a, b] = await sharedDatabase(2);
  if (a === undefined || b === undefined) throw new Error('No database');
  return [a, b];
}

function limiterOn(
  db: LibsqlDb,
  options: Partial<DatabaseMoxfieldLimiterOptions> = {},
): DatabaseMoxfieldLimiter {
  return new DatabaseMoxfieldLimiter({
    db: () => Promise.resolve(db),
    intervalMs: DEFAULT_MOXFIELD_REQUEST_INTERVAL_MS,
    logger: recordingLogger(),
    ...options,
  });
}

function refusal(promise: Promise<unknown>): Promise<DeckSourceError> {
  return expectRejection(promise, DeckSourceError);
}

describe('Moxfield request limiter: spacing across instances', () => {
  it('never starts two requests of any instances closer than the interval, whatever their clocks say', async () => {
    const intervalMs = MIN_MOXFIELD_REQUEST_INTERVAL_MS;
    const offsets = [0, 5 * HOUR_MS, -3 * HOUR_MS, 0.25];
    const dbs = await sharedDatabase(offsets.length);
    const limiters = dbs.map((db, index) =>
      limiterOn(db, { intervalMs, maxWaitMs: 60_000, clock: skewedClock(offsets[index] ?? 0) }),
    );
    const runs = await Promise.all(limiters.map((limiter) => admitSequentially(limiter, 2)));

    expect(runs.flatMap((run) => run.refusals)).toEqual([]);
    const starts = runs.flatMap((run) => run.starts);
    expect(starts).toHaveLength(8);
    const { min, gaps } = startSpacing(starts);
    console.info(
      `[moxfield-limiter] ${starts.length} requests of ${limiters.length} instances, interval ${intervalMs} ms: ` +
        `min spacing ${min.toFixed(1)} ms (gaps ${gaps.map((gap) => gap.toFixed(0)).join(', ')})`,
    );
    // Starts are never before their slot, and one starts at most the margin late (or it gives the
    // slot up), so even a loaded test machine keeps this.
    expect(min).toBeGreaterThanOrEqual(MOXFIELD_MIN_SPACING_MS + MOXFIELD_START_MARGIN_MS);
  }, 60_000);

  it('refuses a request whose slot is further away than the longest wait, as busy', async () => {
    const db = await oneDatabase();
    const limiter = limiterOn(db, { intervalMs: 2_000, maxWaitMs: 3_000 });
    const pending = [limiter.admit(), limiter.admit(), limiter.admit()];
    const settled = await Promise.allSettled(pending);
    expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    const busy = settled[2];
    expect(busy?.status === 'rejected' ? busy.reason : null).toMatchObject({
      code: 'rate-limited',
      message: expect.stringContaining('queued ahead of this one') as unknown,
      retryAfterSeconds: expect.any(Number) as unknown,
    });
  }, 15_000);

  /**
   * A clock that jumps 400 ms while the reservations in `slow` (1-based) are answered: as
   * if the database answered that late, or the event loop was busy. The request could then
   * start up to 400 ms after its slot, more than the 250 ms an interval of 1.5 s allows.
   */
  function slowAnswers(slow: (reservation: number) => boolean): () => number {
    let offset = 0;
    let calls = 0;
    return () => {
      calls += 1;
      // Readings alternate: before sending a reservation (odd), after its answer or wait (even).
      if (calls % 2 === 0 && slow(calls / 2)) offset += 400;
      return performance.now() + offset;
    };
  }

  it('gives a late slot up and reserves another, so a late start never crowds the next request', async () => {
    const db = await oneDatabase();
    const logger = recordingLogger();
    const limiter = limiterOn(db, {
      intervalMs: MIN_MOXFIELD_REQUEST_INTERVAL_MS,
      clock: slowAnswers((reservation) => reservation === 1),
      logger,
    });
    const before = preciseNow();
    await limiter.admit();
    // The second slot, one interval after the abandoned one.
    expect(preciseNow() - before).toBeGreaterThanOrEqual(MIN_MOXFIELD_REQUEST_INTERVAL_MS - 5);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'A Moxfield request slot passed before the request could start; reserving another',
        context: expect.objectContaining({
          intervalMs: MIN_MOXFIELD_REQUEST_INTERVAL_MS,
          reservation: 1,
        }) as unknown,
      }),
    );
  }, 15_000);

  it('fails as busy when every slot would start late', async () => {
    const db = await oneDatabase();
    const limiter = limiterOn(db, {
      intervalMs: MIN_MOXFIELD_REQUEST_INTERVAL_MS,
      clock: slowAnswers(() => true),
    });
    expect(await refusal(limiter.admit())).toMatchObject({ code: 'rate-limited' });
  }, 15_000);
});

describe('Moxfield request limiter: 429', () => {
  const quick = {
    intervalMs: 100,
    baseBackoffMs: 400,
    maxBackoffMs: 1_600,
    slowPeriodMs: 1_000,
    maxWaitMs: 5_000,
  };

  it('slows every instance down together, backs off exponentially and recovers on its own', async () => {
    const [dbA, dbB] = await twoDatabases();
    const a = limiterOn(dbA, quick);
    const b = limiterOn(dbB, quick);

    // Instance A gets a 429 without Retry-After: everyone waits 400 ms.
    expect(await a.rateLimited(undefined)).toBe(1);
    expect(await b.status()).toMatchObject({
      state: 'rate-limited',
      reason: expect.stringContaining('429') as unknown,
    });
    const details = await b.details();
    expect(details).toMatchObject({ currentIntervalMs: 200, rateLimitCount: 1 });
    expect(details.slowedUntil).not.toBeNull();

    // Instance B's next request waits for the backoff, then requests run at half speed.
    const before = preciseNow();
    await b.admit();
    const first = preciseNow();
    expect(first - before).toBeGreaterThanOrEqual(350);
    await a.admit();
    const second = preciseNow();
    expect(second - first).toBeGreaterThanOrEqual(190);

    // Another 429 within the slow period doubles the backoff (800 ms).
    const repo = createRepositories(dbA).moxfieldRate;
    const atSecond = await a.rateLimited(undefined);
    expect(atSecond).toBe(1);
    const state = await repo.state();
    expect(state.backoffLevel).toBe(2);
    expect(state.backoffUntilMs - state.nowMs).toBeGreaterThan(700);
    expect(state.backoffUntilMs - state.nowMs).toBeLessThanOrEqual(800);

    // After the backoff and the quiet period, the interval is back to normal.
    await new Promise((resolve) => setTimeout(resolve, 800 + 1_000 + 50));
    expect(await b.status()).toEqual({ state: 'available' });
    expect((await b.details()).currentIntervalMs).toBe(100);
    await b.admit();
    const third = preciseNow();
    await a.admit();
    expect(preciseNow() - third).toBeLessThan(190);
    // And the next 429 starts the series over.
    await a.rateLimited(undefined);
    expect((await repo.state()).backoffLevel).toBe(1);
  }, 15_000);

  it("honors Moxfield's Retry-After for every instance, refusing at once what would wait too long", async () => {
    const [dbA, dbB] = await twoDatabases();
    const a = limiterOn(dbA, { ...quick, maxWaitMs: 1_000 });
    const b = limiterOn(dbB, { ...quick, maxWaitMs: 1_000 });
    expect(await a.rateLimited(120)).toBe(120);
    const refused = await refusal(b.admit());
    expect(refused).toMatchObject({
      code: 'rate-limited',
      message: expect.stringContaining('HTTP 429') as unknown,
    });
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(119);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(120);
  });

  it('caps an absurd Retry-After', async () => {
    const db = await oneDatabase();
    const limiter = limiterOn(db, { maxRetryAfterMs: 60_000 });
    expect(await limiter.rateLimited(10_000_000)).toBe(60);
  });

  it('cancels a request that waited for its slot when a 429 arrived meanwhile', async () => {
    const [dbA, dbB] = await twoDatabases();
    const a = limiterOn(dbA, { ...quick, intervalMs: 600 });
    const b = limiterOn(dbB, { ...quick, intervalMs: 600 });
    await a.admit();
    // B's slot is 600 ms away; A's request is answered 429 before it comes.
    const waiting = refusal(b.admit());
    await a.rateLimited(30);
    expect(await waiting).toMatchObject({ code: 'rate-limited' });
  });
});

describe('Moxfield request limiter: refusals pause every instance until resumed', () => {
  it('pauses on a refusal, keeps the first reason, and resumes only when told', async () => {
    const [dbA, dbB] = await twoDatabases();
    const a = limiterOn(dbA, { intervalMs: 0 });
    const b = limiterOn(dbB, { intervalMs: 0 });
    await a.blocked('Moxfield refused a request (HTTP 403) for /v3/decks/all/x.');
    await b.blocked('A later refusal.');

    const status = await b.status();
    expect(status).toEqual({
      state: 'paused',
      reason: 'Moxfield refused a request (HTTP 403) for /v3/decks/all/x.',
      pausedAt: expect.any(String) as unknown,
    });
    const refused = await refusal(b.admit());
    expect(refused).toMatchObject({
      code: 'blocked',
      message: expect.stringMatching(
        /paused: Moxfield refused a request \(HTTP 403\).*Admin page.*bookmarklet/,
      ) as unknown,
    });
    // Time alone does not end it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await a.status()).state).toBe('paused');

    expect(await b.resume()).toBe(true);
    expect(await a.resume()).toBe(false);
    expect(await a.status()).toEqual({ state: 'available' });
    await expect(a.admit()).resolves.toBeUndefined();
  });
});

describe('Moxfield request limiter: fails closed', () => {
  function clientOn(limiter: DatabaseMoxfieldLimiter) {
    const fetchImpl = fakeFetch(() => jsonResponse({ ok: 1 }));
    const client = new MoxfieldHttpClient({
      apiBaseUrl: 'https://api2.moxfield.test',
      timeoutMs: 1_000,
      limiter,
      fetchImpl,
    });
    return { client, calls: fetchImpl.calls };
  }

  it('sends nothing when the database cannot be opened', async () => {
    const logger = recordingLogger();
    const limiter = new DatabaseMoxfieldLimiter({
      db: () => Promise.reject(new Error('connect ECONNREFUSED')),
      intervalMs: 0,
      logger,
    });
    const { client, calls } = clientOn(limiter);
    const error = await refusal(client.getDeckJson('FixtureDeckId_00000001'));
    expect(error).toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('nothing was sent') as unknown,
    });
    expect(calls).toHaveLength(0);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'Could not reserve a request slot; nothing was sent to Moxfield',
      }),
    );
  });

  it('sends nothing when the database fails mid-way (closed connection)', async () => {
    const handle = await openTestDatabaseHandle({ url: scratchFileUrl('closed.db') });
    const limiter = limiterOn(handle.db, { intervalMs: 0 });
    const { client, calls } = clientOn(limiter);
    await expect(client.getDeckJson('FixtureDeckId_00000001')).resolves.toEqual({ ok: 1 });
    handle.close();
    expect((await refusal(client.getDeckJson('FixtureDeckId_00000001'))).code).toBe('unavailable');
    expect(calls).toHaveLength(1);
  });

  it('sends nothing when the limiter row is missing', async () => {
    const db = await oneDatabase();
    await db.run(sql`DELETE FROM moxfield_rate`);
    const limiter = limiterOn(db, { intervalMs: 0 });
    const { client, calls } = clientOn(limiter);
    expect((await refusal(client.getDeckJson('FixtureDeckId_00000001'))).code).toBe('unavailable');
    await expect(limiter.status()).rejects.toThrow('rate limiter row is missing');
    expect(calls).toHaveLength(0);
  });
});
