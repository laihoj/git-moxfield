/**
 * `POST /api/e2e/reset`, the end-to-end suite's reset hook: it ends the server-fetch
 * pause of every deck source, and only exists when `GIT_MOXFIELD_E2E` is set.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MoxfieldDeckSource } from '@/integrations/moxfield/moxfield-deck-source';
import { cloudflareBlockResponse, fakeFetch } from '@/integrations/moxfield/test-fixtures';
import type * as ConfigModule from '@/server/config';
import { parseConfig, type AppConfig } from '@/server/config';
import type * as SourcesModule from '@/server/sources';
import { createStaticDeckSourceRegistry, type DeckSourceRegistry } from '@/server/sources';

const state = vi.hoisted(() => ({
  config: undefined as AppConfig | undefined,
  registry: undefined as DeckSourceRegistry | undefined,
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
  getDeckSourceRegistry: (): DeckSourceRegistry => {
    if (state.registry === undefined) throw new Error('No registry for this test');
    return state.registry;
  },
}));

const { POST } = await import('@/app/api/e2e/reset/route');

/** A Moxfield source whose server fetching is paused by a (fake) Cloudflare block. */
async function blockedSource(): Promise<MoxfieldDeckSource> {
  const source = new MoxfieldDeckSource({ fetchImpl: fakeFetch(() => cloudflareBlockResponse()) });
  await source.getDeck({ source: 'moxfield', externalId: 'FixtureDeckId_00000001' }).catch(() => undefined);
  expect(source.serverFetchStatus().state).toBe('blocked');
  return source;
}

describe('POST /api/e2e/reset', () => {
  let source: MoxfieldDeckSource;

  beforeEach(async () => {
    source = await blockedSource();
    state.registry = createStaticDeckSourceRegistry([source]);
  });

  it('resumes server fetching when the e2e flag is set', async () => {
    state.config = parseConfig({ GIT_MOXFIELD_E2E: 'true' });
    const response = POST();
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(source.serverFetchStatus()).toEqual({ state: 'available' });
  });

  it.each([
    ['unset', {}],
    ['false', { GIT_MOXFIELD_E2E: 'false' }],
  ])('does not exist when the e2e flag is %s', async (_label, env) => {
    state.config = parseConfig(env);
    const response = POST();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found.\n');
    expect(source.serverFetchStatus().state).toBe('blocked');
  });
});
