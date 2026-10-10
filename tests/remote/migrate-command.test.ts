/**
 * `pnpm db:migrate` (scripts/migrate.ts) against a remote libSQL server: what Netlify runs
 * after every production build. It migrates the database `TURSO_DATABASE_URL` names (on
 * Netlify too, where it refuses local databases), and the app then opens it.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { parseConfig } from '@/server/config';
import { openDatabase } from '@/server/db/client';
import { bundledMigrations, checkMigrationState } from '@/server/db/migration-state';

import { runMigrateCommand } from '../../scripts/migrate';

import { remoteTarget, wipeRemoteDatabase } from './support';

beforeAll(async () => {
  await wipeRemoteDatabase();
});

async function migrate(platform: Record<string, string>) {
  const { url, authToken } = remoteTarget();
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMigrateCommand({
    config: parseConfig({ TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: authToken }),
    env: platform,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
  });
  return { code, out, err };
}

describe('pnpm db:migrate on a remote database', () => {
  it('migrates it in a Netlify build, then finds it up to date, and the app opens it', async () => {
    const all = bundledMigrations().map((entry) => entry.tag);
    const first = await migrate({ NETLIFY: 'true' });
    expect(first.err).toEqual([]);
    expect(first.code).toBe(0);
    expect(first.out[0]).toMatch(/^Migrating the remote database /);
    expect(first.out).toContain(`Applied ${all.length} migrations:`);
    expect(first.out.at(-1)).toBe(`Up to date: all ${all.length} migrations applied.`);

    const second = await migrate({ NETLIFY: 'true' });
    expect(second.code).toBe(0);
    expect(second.out.at(-1)).toBe(`Already up to date (${all.length} migrations applied).`);

    const { url, authToken } = remoteTarget();
    const handle = await openDatabase({ url, authToken });
    try {
      expect((await checkMigrationState(handle.db)).status).toBe('up-to-date');
    } finally {
      handle.close();
    }
  });

  it('names TURSO_AUTH_TOKEN when the server refuses the credentials', async (context) => {
    const { url, authToken } = remoteTarget();
    if (authToken === undefined) context.skip('the server under test asks for no token');
    const attempt = async (token: string | undefined) => {
      const err: string[] = [];
      const code = await runMigrateCommand({
        config: parseConfig({ TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: token }),
        env: { NETLIFY: 'true' },
        io: { out: () => undefined, err: (line) => err.push(line) },
      });
      expect(code).toBe(1);
      return err.join('\n');
    };
    expect(await attempt(undefined)).toMatch(
      /Server returned HTTP status 401\. The database needs a token, and TURSO_AUTH_TOKEN is not set\./,
    );
    const refused = await attempt('eyJhbGciOiJFZERTQSJ9.e30.not-a-signature');
    expect(refused).toMatch(/Server returned HTTP status 401\. The database refused TURSO_AUTH_TOKEN/);
    expect(refused).not.toContain('not-a-signature');
  });
});
