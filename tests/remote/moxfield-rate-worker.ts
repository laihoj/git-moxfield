/**
 * One serverless function instance for `moxfield-rate.test.ts`, run as a process of its
 * own with a database client, a write lock and a (skewed) clock of its own: admits
 * `REQUESTS` requests to Moxfield one after the other through the installation-wide
 * limiter, starting at `START_AT` (epoch ms), and prints when each would have been sent.
 *
 *   INSTANCE=a REQUESTS=3 CLOCK_OFFSET_MS=3600000 START_AT=… LIBSQL_TEST_URL=… \
 *     node --import tsx --conditions=react-server tests/remote/moxfield-rate-worker.ts
 */
import { openDatabase } from '@/server/db/client';
import type { Logger } from '@/server/logger';
import { DatabaseMoxfieldLimiter } from '@/server/moxfield-limiter';
import { MIN_MOXFIELD_REQUEST_INTERVAL_MS } from '@/integrations/moxfield/constants';
// Not `@tests/support/…` modules that import Vitest: it only works inside a test run.
import { admitSequentially, preciseNow, skewedClock } from '@tests/support/moxfield-rate';

import { remoteTarget } from './support';

export interface RateWorkerReport {
  /** When each admitted request would have been sent (`preciseNow`). */
  starts: number[];
  refusals: string[];
  /** Late slots given up and reserved again. */
  lateSlots: number;
}

async function main(): Promise<void> {
  const { url, authToken } = remoteTarget();
  const handle = await openDatabase({ url, authToken });
  try {
    let lateSlots = 0;
    const silent = (): void => undefined;
    const logger: Logger = {
      debug: silent,
      info: silent,
      warn: (message) => {
        if (message.startsWith('A Moxfield request slot passed')) lateSlots += 1;
      },
      error: silent,
    };
    const limiter = new DatabaseMoxfieldLimiter({
      db: () => Promise.resolve(handle.db),
      intervalMs: MIN_MOXFIELD_REQUEST_INTERVAL_MS,
      maxWaitMs: 120_000,
      clock: skewedClock(Number(process.env.CLOCK_OFFSET_MS ?? '0')),
      logger,
    });
    const startAt = Number(process.env.START_AT ?? '0');
    const delay = startAt - preciseNow();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const { starts, refusals } = await admitSequentially(limiter, Number(process.env.REQUESTS ?? '3'));
    const report: RateWorkerReport = { starts, refusals, lateSlots };
    process.stdout.write(JSON.stringify(report));
  } finally {
    handle.close();
  }
}

if (process.env.INSTANCE !== undefined) await main();
