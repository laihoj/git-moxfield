/**
 * One serverless function instance for `concurrency.test.ts`, run as a process of its own:
 * captures a state of its own into the shared deck, then lists the decks, compares and
 * commits it, `ROUNDS` times, against the server the remote suite tests. Prints a JSON
 * {@link InstanceReport} on stdout.
 *
 *   INSTANCE=a ROUNDS=30 LIBSQL_TEST_URL=… node --import tsx --conditions=react-server tests/remote/instance-worker.ts
 */
import { parseConfig } from '@/server/config';
import { LOCAL_WORKSPACE_ID, openDatabase } from '@/server/db/client';
import type { Logger } from '@/server/logger';
import { createServices, KeyedMutex, type DeckServices } from '@/server/services';
import { createDeckSourceRegistry } from '@/server/sources';
// Not `@tests/support/services`: it imports Vitest, which only works inside a test run.
import { buildCaptureEnvelope, type MoxDeckSpec } from '@tests/support/moxfield-deck-builder';

import { remoteTarget } from './support';

export interface InstanceReport {
  /** `<operation>:<outcome>` per operation that returned. */
  outcomes: string[];
  /** `<operation>: <message>` per operation that threw. */
  failures: string[];
}

export const CONCURRENT_DECK: MoxDeckSpec = {
  publicId: 'ConcurrentDeck00000001',
  name: 'Concurrent',
  format: 'commander',
  commanders: ['Tymna the Weaver'],
  mainboard: ['Sol Ring', 'Mana Vault', '3 Island'],
};

async function work(services: DeckServices, name: string, rounds: number): Promise<InstanceReport> {
  const report: InstanceReport = { outcomes: [], failures: [] };
  const attempt = async (what: string, operation: () => Promise<string>): Promise<void> => {
    try {
      report.outcomes.push(`${what}:${await operation()}`);
    } catch (error) {
      report.failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  for (let round = 0; round < rounds; round++) {
    let deckId: string | undefined;
    await attempt('capture', async () => {
      const spec = {
        ...CONCURRENT_DECK,
        version: round + 2,
        mainboard: [...(CONCURRENT_DECK.mainboard ?? []), `Card ${name}-${round}`],
      };
      const captured = await services.ingestCapture({
        data: buildCaptureEnvelope(spec, new Date().toISOString()),
        method: 'browser-capture',
        track: true,
      });
      if (captured.status === 'ingested') deckId = captured.deckId;
      return captured.status;
    });
    if (deckId === undefined) continue;
    const id = deckId;
    await Promise.all([
      attempt('list', async () => `${(await services.listDecks()).length}`),
      attempt('compare', async () => ((await services.compare(id, 'empty', 'working')) ? 'ok' : 'none')),
      attempt('commit', async () => {
        const overview = await services.getOverview(id);
        if (!overview?.working) return 'no-working-state';
        const outcome = await services.commit(id, {
          message: `${name} round ${round}`,
          expectedObservationId: overview.working.id,
          expectedHeadCommitId: overview.head?.commitId ?? null,
        });
        return outcome.ok ? 'ok' : outcome.reason;
      }),
    ]);
  }
  return report;
}

async function main(): Promise<void> {
  const { url, authToken } = remoteTarget();
  const handle = await openDatabase({ url, authToken });
  try {
    const config = parseConfig({ MOXFIELD_SERVER_FETCH: 'off' });
    const silent = (): void => undefined;
    const logger: Logger = { debug: silent, info: silent, warn: silent, error: silent };
    const services = createServices({
      db: handle.db,
      sources: createDeckSourceRegistry(config, { logger }),
      config,
      workspaceId: LOCAL_WORKSPACE_ID,
      logger,
      locks: new KeyedMutex(),
    });
    const report = await work(services, process.env.INSTANCE ?? 'a', Number(process.env.ROUNDS ?? '10'));
    process.stdout.write(JSON.stringify(report));
  } finally {
    handle.close();
  }
}

if (process.env.INSTANCE !== undefined) await main();
