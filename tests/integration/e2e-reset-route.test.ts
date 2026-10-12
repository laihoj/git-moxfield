/**
 * `POST /api/e2e/reset`, the end-to-end suite's reset hook: it resets the installation-wide
 * Moxfield request limiter (a pause after a refusal, a 429 backoff), and only exists when
 * `GIT_MOXFIELD_E2E` is set.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ConfigModule from '@/server/config';
import { parseConfig, type AppConfig } from '@/server/config';
import { DatabaseMoxfieldLimiter } from '@/server/moxfield-limiter';
import type * as SourcesModule from '@/server/sources';
import { openTestDatabase } from '@tests/support/db';
import { recordingLogger } from '@tests/support/recording-logger';

const state = vi.hoisted(() => ({
  config: undefined as AppConfig | undefined,
  limiter: undefined as DatabaseMoxfieldLimiter | undefined,
}));

vi.mock('@/server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigModule>()),
  getConfig: (): AppConfig => {
    if (state.config === undefined) throw new Error('No config for this test');
    return state.config;
  },
}));

vi.mock('@/server/sources', async (importOriginal) => ({
  ...(await importOriginal<typeof SourcesModule>()),
  getMoxfieldLimiter: (): DatabaseMoxfieldLimiter => {
    if (state.limiter === undefined) throw new Error('No limiter for this test');
    return state.limiter;
  },
}));

const { POST } = await import('@/app/api/e2e/reset/route');

describe('POST /api/e2e/reset', () => {
  let limiter: DatabaseMoxfieldLimiter;

  beforeEach(async () => {
    const db = await openTestDatabase();
    limiter = new DatabaseMoxfieldLimiter({
      db: () => Promise.resolve(db),
      intervalMs: 0,
      logger: recordingLogger(),
    });
    state.limiter = limiter;
    await limiter.rateLimited(600);
    await limiter.blocked('Moxfield refused a request (HTTP 403).');
    expect((await limiter.status()).state).toBe('paused');
  });

  it('resets the request limiter when the e2e flag is set', async () => {
    state.config = parseConfig({ GIT_MOXFIELD_E2E: 'true' });
    const response = await POST();
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    // Neither paused nor backing off any more.
    expect(await limiter.status()).toEqual({ state: 'available' });
  });

  it.each([
    ['unset', {}],
    ['false', { GIT_MOXFIELD_E2E: 'false' }],
  ])('does not exist when the e2e flag is %s', async (_label, env) => {
    state.config = parseConfig(env);
    const response = await POST();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found.\n');
    expect((await limiter.status()).state).toBe('paused');
  });
});
