/**
 * `pnpm db:migrate` (scripts/migrate.ts) against local database files: what it applies and
 * reports, and that it refuses a local database on Netlify, where the build container's
 * disk is thrown away (it would report success while the Turso database stays unmigrated).
 * The remote suite runs the same command against a libSQL server (`tests/remote`).
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { parseConfig } from '@/server/config';
import { LOCAL_WORKSPACE_ID } from '@/server/db/client';
import { createLibsqlDatabase } from '@/server/db/libsql';
import { bundledMigrations, checkMigrationState } from '@/server/db/migration-state';
import { workspaces } from '@/server/db/schema';
import type { PlatformEnv } from '@/server/platform';
import { refusingUrl, startHranaStub, tempDir } from '@tests/support/libsql';

import { runMigrateCommand } from '../../../scripts/migrate';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = tempDir('git-moxfield-migrate-');
  dirs.push(dir);
  return dir;
}

/** A copy of `drizzle/` whose journal ends `drop` migrations early (an older build's). */
function olderMigrations(drop: number): string {
  const folder = join(scratchDir(), 'drizzle');
  cpSync(join(process.cwd(), 'drizzle'), folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, journal.entries.length - drop);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

async function migrate(
  env: Record<string, string>,
  options: { platform?: PlatformEnv; folder?: string } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMigrateCommand({
    config: parseConfig(env),
    env: options.platform ?? {},
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    ...(options.folder === undefined ? {} : { migrationsFolder: options.folder }),
  });
  return { code, out, err };
}

const ALL = bundledMigrations().map((entry) => entry.tag);

describe('pnpm db:migrate', () => {
  it('creates and migrates a new local database, then finds it up to date', async () => {
    const path = join(scratchDir(), 'app.db');
    const first = await migrate({ DATABASE_PATH: path });
    expect(first).toEqual({
      code: 0,
      out: [
        `Created a new database file ${path}`,
        `Applied ${ALL.length} migrations:`,
        ...ALL.map((tag) => `  ${tag}`),
        'Referential integrity verified (PRAGMA foreign_key_check).',
        `Up to date: all ${ALL.length} migrations applied.`,
      ],
      err: [],
    });

    const second = await migrate({ DATABASE_PATH: path });
    expect(second).toEqual({
      code: 0,
      out: [`Migrating the database file ${path}`, `Already up to date (${ALL.length} migrations applied).`],
      err: [],
    });

    const handle = await createLibsqlDatabase({ url: `file:${path}` });
    try {
      expect((await checkMigrationState(handle.db)).status).toBe('up-to-date');
      const local = await handle.db.select().from(workspaces).where(eq(workspaces.id, LOCAL_WORKSPACE_ID));
      expect(local).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it('applies only what a database migrated by an older build lacks, and names it', async () => {
    const path = join(scratchDir(), 'app.db');
    expect((await migrate({ DATABASE_PATH: path }, { folder: olderMigrations(1) })).code).toBe(0);

    const upgrade = await migrate({ TURSO_DATABASE_URL: `file:${path}` });
    expect(upgrade.code).toBe(0);
    expect(upgrade.out).toEqual([
      `Migrating the database file ${path}`,
      'Applied 1 migration:',
      `  ${ALL.at(-1) ?? ''}`,
      'Referential integrity verified (PRAGMA foreign_key_check).',
      `Up to date: all ${ALL.length} migrations applied.`,
    ]);
  });

  it('refuses a database migrated by a newer build, changing nothing', async () => {
    const path = join(scratchDir(), 'app.db');
    expect((await migrate({ DATABASE_PATH: path })).code).toBe(0);

    const older = await migrate({ DATABASE_PATH: path }, { folder: olderMigrations(2) });
    expect(older.code).toBe(1);
    expect(older.err).toEqual([
      expect.stringMatching(
        /^Migrating the database file .* failed: The database was migrated by a newer version of git-moxfield \(2 unknown migrations\)/,
      ),
    ]);
  });

  describe('on Netlify', () => {
    it.each<[string, PlatformEnv]>([
      ['a build', { NETLIFY: 'true' }],
      ['a function', { SITE_ID: 'site-1' }],
    ])(
      'refuses the local file at DATABASE_PATH in %s (TURSO_DATABASE_URL is not set)',
      async (_, platform) => {
        const path = join(scratchDir(), 'app.db');
        const refused = await migrate({ DATABASE_PATH: path }, { platform });
        expect(refused.code).toBe(1);
        expect(refused.out).toEqual([]);
        expect(refused.err).toEqual([
          expect.stringMatching(
            /^Refusing to migrate the database file .*: TURSO_DATABASE_URL is not set, so this would migrate a local database file in the Netlify build container/,
          ),
        ]);
        expect(existsSync(path)).toBe(false);
      },
    );

    it.each(['file', 'memory'])(
      'refuses a TURSO_DATABASE_URL that names a local (%s) database',
      async (kind) => {
        const path = join(scratchDir(), 'app.db');
        const url = kind === 'file' ? `file:${path}` : ':memory:';
        const refused = await migrate({ TURSO_DATABASE_URL: url }, { platform: { NETLIFY: 'true' } });
        expect(refused.code).toBe(1);
        expect(refused.err).toEqual([
          expect.stringContaining(
            'TURSO_DATABASE_URL names a local database, which does not survive the Netlify',
          ),
        ]);
        expect(existsSync(path)).toBe(false);
      },
    );

    it('migrates locally under `netlify dev`, which is not a deploy', async () => {
      const path = join(scratchDir(), 'app.db');
      const result = await migrate(
        { DATABASE_PATH: path },
        { platform: { NETLIFY: 'true', NETLIFY_DEV: 'true' } },
      );
      expect(result.code).toBe(0);
    });
  });

  it('reports a database it cannot open without echoing its URL', async () => {
    const result = await migrate({ TURSO_DATABASE_URL: 'http://127.0.0.1:9/?authToken=url-secret' });
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      expect.stringMatching(/^Could not open the remote database 127\.0\.0\.1:9: /),
    ]);
    expect(result.err.join('\n')).not.toContain('url-secret');
  });

  describe('names the variables to fix when the remote database cannot be used', () => {
    const TOKEN = 'eyJhbGciOiJFZERTQSJ9.token-secret';

    /** `pnpm db:migrate` against a server that answers every request with `status`. */
    async function refusedWith(status: number, env: Record<string, string> = {}) {
      const server = await startHranaStub({ status });
      try {
        const result = await migrate({ TURSO_DATABASE_URL: server.url, ...env });
        expect(server.requests()).toBeGreaterThan(0);
        expect(result.code).toBe(1);
        expect(result.out).toEqual([]);
        expect(result.err).toHaveLength(1);
        expect(result.err.join('\n')).not.toContain('token-secret');
        return result.err[0] ?? '';
      } finally {
        await server.close();
      }
    }

    it('says that TURSO_AUTH_TOKEN is not set when the server asks for a token (401)', async () => {
      const message = await refusedWith(401);
      expect(message).toMatch(
        /^Could not open the remote database 127\.0\.0\.1:\d+: Server returned HTTP status 401\. /,
      );
      expect(message).toContain('TURSO_AUTH_TOKEN is not set');
      expect(message).toContain('turso db tokens create <database>');
    });

    it('says that the server refused TURSO_AUTH_TOKEN (401), for which database', async () => {
      const message = await refusedWith(401, { TURSO_AUTH_TOKEN: TOKEN });
      expect(message).toContain('The database refused TURSO_AUTH_TOKEN');
      expect(message).toContain('TURSO_DATABASE_URL');
      expect(message).not.toContain('is not set');
    });

    it('asks for a token that may write (403)', async () => {
      const message = await refusedWith(403, { TURSO_AUTH_TOKEN: TOKEN });
      expect(message).toContain('Server returned HTTP status 403. TURSO_AUTH_TOKEN is not allowed');
      expect(message).toContain('read-only');
    });

    it('asks to check TURSO_DATABASE_URL when no database answers there (404)', async () => {
      const message = await refusedWith(404, { TURSO_AUTH_TOKEN: TOKEN });
      expect(message).toContain('No database answers at TURSO_DATABASE_URL');
      expect(message).toContain('turso db show <database> --url');
    });

    it('asks to check TURSO_DATABASE_URL and the network when the host cannot be reached', async () => {
      const result = await migrate({ TURSO_DATABASE_URL: await refusingUrl(), TURSO_AUTH_TOKEN: TOKEN });
      expect(result.code).toBe(1);
      expect(result.err).toEqual([
        expect.stringMatching(
          /^Could not open the remote database 127\.0\.0\.1:\d+: connect ECONNREFUSED .*\. The host TURSO_DATABASE_URL names could not be reached\. Check the URL/,
        ),
      ]);
      expect(result.err.join('\n')).not.toContain('token-secret');
    });

    it('gives no such hint for other failures', async () => {
      const message = await refusedWith(500, { TURSO_AUTH_TOKEN: TOKEN });
      expect(message).toMatch(/Server returned HTTP status 500$/);
    });
  });
});
