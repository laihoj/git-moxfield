/**
 * Flows that tests, the remote suite's worker processes and the demo seed run the same
 * way: handing a deck state over like the bookmarklet does, committing the working state
 * the user reviewed, and the services of an instance that only receives captures.
 *
 * Free of test-runner imports: the worker (`tests/remote/instance-worker.ts`) and the
 * seed script (`scripts/seed-demo.ts`) run under tsx, outside Vitest.
 */
import type { CapturedIngestMethod } from '@/integrations/deck-source';
import { parseConfig } from '@/server/config';
import { LOCAL_WORKSPACE_ID, type Db } from '@/server/db/client';
import type { Logger } from '@/server/logger';
import { createServices, type CommitOutcome, type DeckServices } from '@/server/services';
import { DatabaseMoxfieldLimiter } from '@/server/moxfield-limiter';
import { createDeckSourceRegistry } from '@/server/sources';

import {
  buildCaptureEnvelope,
  buildMoxfieldDeck,
  buildMoxfieldPrimer,
  type MoxDeckSpec,
} from './moxfield-deck-builder';

/**
 * Hands `spec` to the services like a user's browser does and returns the deck's id:
 * the bookmarklet's capture envelope (`capturedAt` is its timestamp), or the two API
 * responses pasted into the paste form.
 * @throws {Error} unless the capture was ingested.
 */
export async function captureSpec(
  services: DeckServices,
  spec: MoxDeckSpec,
  capturedAt: string,
  method: CapturedIngestMethod = 'browser-capture',
): Promise<string> {
  const data =
    method === 'browser-capture'
      ? buildCaptureEnvelope(spec, capturedAt)
      : { deck: JSON.stringify(buildMoxfieldDeck(spec)), primer: JSON.stringify(buildMoxfieldPrimer(spec)) };
  const outcome = await services.ingestCapture({ data, method, track: true });
  if (outcome.status !== 'ingested') throw new Error(`Capture not ingested: ${outcome.status}`);
  return outcome.deckId;
}

/**
 * Commits the deck's current working state on top of its HEAD, as the commit form does
 * after a review: one overview read and one commit.
 */
export async function commitWorkingState(
  services: DeckServices,
  deckId: string,
  input: { message: string; tags?: string[] },
): Promise<CommitOutcome> {
  const overview = await services.getOverview(deckId);
  if (!overview?.working) {
    return { ok: false, reason: 'no-working-state', message: 'The deck has no working state to commit.' };
  }
  return services.commit(deckId, {
    message: input.message,
    expectedObservationId: overview.working.id,
    expectedHeadCommitId: overview.head?.commitId ?? null,
    ...(input.tags ? { tags: input.tags } : {}),
  });
}

/**
 * Services that only receive captures (server fetching is off), with deck locks of their
 * own: another function instance, as on Netlify. `env` is added to the configuration.
 */
export function captureOnlyServices(
  db: Db,
  deps: {
    logger: Logger;
    workspaceId?: string;
    now?: () => Date;
    fetchImpl?: typeof fetch;
    env?: Record<string, string | undefined>;
  },
): DeckServices {
  const config = parseConfig({ ...deps.env, MOXFIELD_SERVER_FETCH: 'off' });
  return createServices({
    db,
    sources: createDeckSourceRegistry(config, {
      moxfieldLimiter: new DatabaseMoxfieldLimiter({
        db: () => Promise.resolve(db),
        intervalMs: config.MOXFIELD_MIN_REQUEST_INTERVAL_MS,
        logger: deps.logger,
      }),
      logger: deps.logger,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    config,
    workspaceId: deps.workspaceId ?? LOCAL_WORKSPACE_ID,
    ...(deps.now ? { now: deps.now } : {}),
    logger: deps.logger,
  });
}
