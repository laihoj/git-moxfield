/**
 * What the route handler tests share: the service harness a test's mocked modules read
 * (`getAuthService`, `servicesFor`, `getConfig`, … return parts of it) and the hooks that
 * create it. `vi.mock` is hoisted per file, so each test keeps its own mocks and its
 * `vi.hoisted` state; this module is the part that can be shared.
 *
 *     const state = vi.hoisted(() => ({ harness: undefined as ServiceHarness | undefined, logs: [] as LogEntry[] }));
 *     vi.mock('@/server/auth', async (importOriginal) => ({
 *       ...(await importOriginal<typeof AuthModule>()),
 *       getAuthService: () => Promise.resolve(currentHarness(state).auth),
 *     }));
 *     setUpRouteHarness(state, { fakeDate: true });
 */
import { afterEach, beforeEach, vi } from 'vitest';

import type { LogEntry } from './recording-logger';
import { createServiceHarness, type ServiceHarness } from './services';

export interface RouteHarnessState {
  harness: ServiceHarness | undefined;
  /** The entries the test's logger mock records into (cleared before each test). */
  logs?: LogEntry[];
}

/** The harness of the running test. */
export function currentHarness(state: RouteHarnessState): ServiceHarness {
  if (state.harness === undefined) throw new Error('No harness for this test');
  return state.harness;
}

/**
 * Creates the harness before each test and drops it after. With `fakeDate`, `Date` is
 * faked and set to the services' clock: cookie lifetimes are computed with the system
 * clock.
 */
export function setUpRouteHarness(state: RouteHarnessState, options: { fakeDate?: boolean } = {}): void {
  beforeEach(async () => {
    state.harness = await createServiceHarness();
    if (options.fakeDate === true) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(state.harness.clock.now());
    }
    if (state.logs) state.logs.length = 0;
  });
  afterEach(() => {
    if (options.fakeDate === true) vi.useRealTimers();
    state.harness = undefined;
  });
}
