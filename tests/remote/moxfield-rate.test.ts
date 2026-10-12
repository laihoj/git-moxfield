/**
 * The installation-wide Moxfield request limiter (ADR 0009) on a real libSQL server, as on
 * Netlify with Turso: function instances in processes of their own (each with a client, a
 * write lock and a clock of its own, skewed by hours) never start two requests to Moxfield
 * closer than the interval; the server's clock has sub-second resolution; reservations are
 * serialized by the server, so no two instances ever get the same slot; and a 429 or a
 * refusal seen by one instance holds back all of them.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  MIN_MOXFIELD_REQUEST_INTERVAL_MS,
  MOXFIELD_MIN_SPACING_MS,
  MOXFIELD_START_MARGIN_MS,
} from '@/integrations/moxfield/constants';
import type { LibsqlDb } from '@/server/db/libsql';
import { DatabaseMoxfieldLimiter } from '@/server/moxfield-limiter';
import { createRepositories } from '@/server/repositories';
import { DB_NOW_MS } from '@/server/repositories/moxfield-rate';
import { admitSequentially, preciseNow, skewedClock, startSpacing } from '@tests/support/moxfield-rate';

import type { RateWorkerReport } from './moxfield-rate-worker';
import { openInstance, resetRemoteDatabase } from './support';

const WORKER = fileURLToPath(new URL('./moxfield-rate-worker.ts', import.meta.url));
const HOUR_MS = 3_600_000;
const silent = (): void => undefined;
const logger = { debug: silent, info: silent, warn: silent, error: silent };

beforeAll(async () => {
  await resetRemoteDatabase({ migrate: true });
});

beforeEach(async () => {
  await createRepositories(openInstance()).moxfieldRate.reset();
});

function runWorker(name: string, env: Record<string, string>): Promise<RateWorkerReport> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', '--conditions=react-server', WORKER],
      { cwd: process.cwd(), env: { ...process.env, INSTANCE: name, ...env }, timeout: 120_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Instance ${name} failed: ${error.message}\n${stderr}`));
          return;
        }
        resolve(JSON.parse(stdout) as RateWorkerReport);
      },
    );
  });
}

function report(label: string, starts: number[]): number {
  const { min, gaps } = startSpacing(starts);
  console.info(
    `[moxfield-rate] ${label}: ${starts.length} requests, min spacing ${min.toFixed(1)} ms ` +
      `(gaps ${gaps.map((gap) => gap.toFixed(0)).join(', ')})`,
  );
  return min;
}

describe('the database clock', () => {
  it('has sub-second resolution and is read once per statement', async () => {
    const db = openInstance();
    const rows = await db.all<{ a: number; b: number; subsec: number }>(
      sql`SELECT ${DB_NOW_MS} AS a, ${DB_NOW_MS} AS b, unixepoch('subsec') AS subsec`,
    );
    const [row] = rows;
    expect(row?.a).toBe(row?.b);
    expect(Math.abs((row?.a ?? 0) - Date.now())).toBeLessThan(5_000);
    const samples: number[] = [];
    for (let index = 0; index < 20; index++) {
      samples.push((await createRepositories(db).moxfieldRate.state()).nowMs);
    }
    // Milliseconds, not whole seconds.
    expect(samples.some((ms) => ms % 1000 !== 0)).toBe(true);
    expect(new Set(samples).size).toBeGreaterThan(1);
  });
});

describe('reservations from many instances at once', () => {
  it('are serialized by the server: every slot is distinct and exactly one interval apart', async () => {
    const instances = Array.from({ length: 4 }, () => createRepositories(openInstance()).moxfieldRate);
    const grants = await Promise.all(
      instances.flatMap((repo) =>
        Array.from({ length: 10 }, () => repo.reserve({ intervalMs: 1_500, maxWaitMs: 3_600_000 })),
      ),
    );
    const slots = grants.map((grant) => (grant.granted ? grant.slotMs : Number.NaN)).sort((a, b) => a - b);
    expect(slots.every(Number.isFinite)).toBe(true);
    expect(new Set(slots).size).toBe(40);
    expect(startSpacing(slots).gaps.every((gap) => gap === 1_500)).toBe(true);
  });
});

describe('requests of function instances in processes of their own', () => {
  it('never start closer than the interval, whatever the instances’ clocks say', async () => {
    const startAt = preciseNow() + 3_000;
    const offsets = [0, 7 * HOUR_MS, -5 * HOUR_MS, 123];
    const reports = await Promise.all(
      offsets.map((offset, index) =>
        runWorker(`p${index}`, {
          REQUESTS: '3',
          CLOCK_OFFSET_MS: String(offset),
          START_AT: String(startAt),
        }),
      ),
    );
    expect(reports.flatMap((entry) => entry.refusals)).toEqual([]);
    const starts = reports.flatMap((entry) => entry.starts);
    expect(starts).toHaveLength(12);
    const lateSlots = reports.reduce((sum, entry) => sum + entry.lateSlots, 0);
    const min = report(
      `4 processes, interval ${MIN_MOXFIELD_REQUEST_INTERVAL_MS} ms, ${lateSlots} late slots given up`,
      starts,
    );
    expect(min).toBeGreaterThanOrEqual(MOXFIELD_MIN_SPACING_MS + MOXFIELD_START_MARGIN_MS);
  }, 120_000);

  it('never start closer than the interval with clients of their own in one process', async () => {
    const offsets = [0, 2 * HOUR_MS, -HOUR_MS];
    const limiters = offsets.map((offset) => {
      const db: LibsqlDb = openInstance();
      return new DatabaseMoxfieldLimiter({
        db: () => Promise.resolve(db),
        intervalMs: MIN_MOXFIELD_REQUEST_INTERVAL_MS,
        maxWaitMs: 60_000,
        clock: skewedClock(offset),
        logger,
      });
    });
    const runs = await Promise.all(limiters.map((limiter) => admitSequentially(limiter, 3)));
    expect(runs.flatMap((run) => run.refusals)).toEqual([]);
    const min = report(
      '3 clients in one process',
      runs.flatMap((run) => run.starts),
    );
    expect(min).toBeGreaterThanOrEqual(MOXFIELD_MIN_SPACING_MS + MOXFIELD_START_MARGIN_MS);
  }, 60_000);
});

describe('429 and refusals across instances', () => {
  function instance(): DatabaseMoxfieldLimiter {
    const db = openInstance();
    return new DatabaseMoxfieldLimiter({
      db: () => Promise.resolve(db),
      intervalMs: 100,
      baseBackoffMs: 500,
      slowPeriodMs: 1_000,
      maxWaitMs: 5_000,
      logger,
    });
  }

  it('a 429 seen by one instance holds back the others, then they run at half speed and recover', async () => {
    const [a, b] = [instance(), instance()];
    await a.rateLimited(undefined);
    expect((await b.status()).state).toBe('rate-limited');
    const before = preciseNow();
    await b.admit();
    expect(preciseNow() - before).toBeGreaterThanOrEqual(400);
    expect((await b.details()).currentIntervalMs).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await a.details()).toMatchObject({ status: { state: 'available' }, currentIntervalMs: 100 });
  });

  it('a refusal seen by one instance pauses all of them until resumed', async () => {
    const [a, b] = [instance(), instance()];
    await a.blocked('Moxfield refused a request (HTTP 403).');
    await expect(b.admit()).rejects.toMatchObject({ code: 'blocked' });
    expect(await b.resume()).toBe(true);
    await expect(a.admit()).resolves.toBeUndefined();
  });
});
