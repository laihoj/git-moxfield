/**
 * Serverless function instances working on one deck at once against a remote libSQL
 * server: separate processes, each with a client, a write lock and deck locks of its own
 * (as on Netlify), whose captures, deck pages, comparisons and commits interleave freely
 * (`instance-worker.ts`).
 *
 * Outside a transaction every statement sees whatever is committed when it runs, and every
 * ingest prunes superseded observations with the snapshots only they referenced. No
 * request may fail because of that: before observations were read together with their
 * snapshots, 5 to 12 % of these rounds failed with "Snapshot … is missing" (8 to 20 of 160
 * in four runs of 4 instances of 40 rounds on sqld 0.24.32). Every commit either records
 * the state its user reviewed or answers why not, and history stays linear.
 *
 * Four instances, not more: sqld 0.24.32 itself can stall for good (every writer spinning
 * in `BEGIN IMMEDIATE`, about 460 % CPU) with six processes running write transactions at
 * once, even plain `@libsql/client` ones without any of the app's code; with three or four
 * it did not in 10 runs each.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { LOCAL_WORKSPACE_ID, openDatabase } from '@/server/db/client';
import { createRepositories } from '@/server/repositories';

import type { InstanceReport } from './instance-worker';
import { remoteTarget, resetRemoteDatabase } from './support';

const INSTANCES = 4;
const ROUNDS = 30;
const WORKER = fileURLToPath(new URL('./instance-worker.ts', import.meta.url));

beforeAll(async () => {
  await resetRemoteDatabase({ migrate: true });
});

/** Runs one instance in a process of its own. */
function runInstance(name: string): Promise<InstanceReport> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', '--conditions=react-server', WORKER],
      {
        cwd: process.cwd(),
        env: { ...process.env, INSTANCE: name, ROUNDS: String(ROUNDS) },
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Instance ${name} failed: ${error.message}\n${stderr}`));
          return;
        }
        resolve(JSON.parse(stdout) as InstanceReport);
      },
    );
  });
}

describe('function instances racing on one deck', () => {
  it('never fail a read or a commit, and keep one linear history', async () => {
    const reports = await Promise.all(
      Array.from({ length: INSTANCES }, (_, index) => runInstance(`i${index}`)),
    );
    expect(reports.flatMap((report) => report.failures)).toEqual([]);
    const outcomes = reports.flatMap((report) => report.outcomes);
    expect(outcomes.filter((outcome) => outcome === 'capture:ingested')).toHaveLength(INSTANCES * ROUNDS);
    for (const outcome of outcomes.filter((entry) => entry.startsWith('commit:'))) {
      expect(['commit:ok', 'commit:stale', 'commit:head-moved']).toContain(outcome);
    }

    const { url, authToken } = remoteTarget();
    const handle = await openDatabase({ url, authToken });
    try {
      const repos = createRepositories(handle.db, { workspaceId: LOCAL_WORKSPACE_ID });
      const [deck, ...others] = await repos.decks.list();
      expect(others).toEqual([]);
      const committed = outcomes.filter((outcome) => outcome === 'commit:ok').length;
      expect(committed).toBeGreaterThan(0);
      const lineage = await repos.commits.lineage(deck?.id ?? '');
      expect(lineage.map((commit) => commit.sequence)).toEqual(
        Array.from({ length: committed }, (_, index) => index + 1),
      );
    } finally {
      handle.close();
    }
  }, 180_000);
});
