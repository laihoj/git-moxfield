/**
 * `pnpm moxfield …` (scripts/moxfield.ts) against a database: the operator sees why server
 * fetching is paused and resumes it for every instance (ADR 0009).
 */
import { describe, expect, it } from 'vitest';

import { parseConfig } from '@/server/config';
import { DatabaseMoxfieldLimiter } from '@/server/moxfield-limiter';
import { runCommand } from '@tests/support/cli';
import { openTestDatabase } from '@tests/support/db';
import { recordingLogger } from '@tests/support/recording-logger';

import { runMoxfieldCommand, USAGE } from '../../../scripts/moxfield';

async function cli(env: Record<string, string> = {}) {
  const db = await openTestDatabase();
  const config = parseConfig(env);
  const limiter = new DatabaseMoxfieldLimiter({
    db: () => Promise.resolve(db),
    intervalMs: 2_000,
    logger: recordingLogger(),
  });
  const run = (...argv: string[]) => runCommand((io) => runMoxfieldCommand(argv, { db, config, io }));
  return { limiter, run };
}

describe('pnpm moxfield', () => {
  it('shows the state of server fetching', async () => {
    const { run } = await cli();
    const status = await run('status');
    expect(status.code).toBe(0);
    expect(status.out).toEqual([
      expect.stringMatching(/^Database: /),
      'MOXFIELD_SERVER_FETCH: auto',
      'Moxfield-issued User-Agent: not configured here',
      'State: running',
      'Interval: 2000 ms between requests (all instances together)',
      '429 answers: none',
    ]);
  });

  it('shows a pause with its reason and resumes it for every instance', async () => {
    const { limiter, run } = await cli();
    await limiter.blocked('Moxfield refused a request (HTTP 403) for /v3/decks/all/abc.');
    const status = await run('status');
    expect(status.out).toContainEqual(expect.stringMatching(/^State: PAUSED since \d{4}-\d{2}-\d{2}T/));
    expect(status.out).toContain('Reason: Moxfield refused a request (HTTP 403) for /v3/decks/all/abc.');
    expect(status.out).toContain('Resume with: pnpm moxfield resume');

    const resumed = await run('resume');
    expect(resumed.code).toBe(0);
    expect(resumed.out[0]).toBe('Server fetching from Moxfield resumed for every instance.');
    expect(resumed.out).toContain('State: running');
    expect(await limiter.status()).toEqual({ state: 'available' });
    expect((await run('resume')).out[0]).toBe(
      'Server fetching from Moxfield was not paused; nothing changed.',
    );
  });

  it('shows a 429 backoff, which only time ends', async () => {
    const { limiter, run } = await cli();
    await limiter.rateLimited(60);
    const status = await run('status');
    expect(status.out).toContainEqual(
      expect.stringMatching(/^State: backing off after a 429 until .* \(ends on its own\)$/),
    );
    expect(status.out).toContainEqual(
      expect.stringMatching(/^Interval: 4000 ms \(doubled after a 429\) until .*, then 2000 ms$/),
    );
    expect(status.out).toContainEqual(expect.stringMatching(/^429 answers: 1, the last at /));
  });

  it('warns when the Moxfield User-Agent is configured outside production, without showing it', async () => {
    const { run } = await cli({ MOXFIELD_USER_AGENT: 'Issued/1.0 (very-secret)' });
    const status = await run('status');
    expect(status.out).toContain('Moxfield-issued User-Agent: configured');
    expect(status.err.join('\n')).toContain('outside the Netlify production deployment');
    expect([...status.out, ...status.err].join('\n')).not.toContain('very-secret');
  });

  it('explains its usage', async () => {
    const { run } = await cli();
    expect(await run()).toMatchObject({ code: 2, err: [USAGE] });
    expect(await run('--help')).toMatchObject({ code: 0, out: [USAGE] });
    const unknown = await run('pause');
    expect(unknown.code).toBe(2);
    expect(unknown.err[0]).toContain('Unknown command "pause"');
  });
});
