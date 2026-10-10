/**
 * `pnpm import:local` into a remote libSQL server (what moving a local installation's
 * history to the hosted instance's Turso database does): the configured remote database is
 * opened without migrating it, content goes over in batches, each deck's history in one
 * transaction, and the result reads exactly like the source.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { parseConfig } from '@/server/config';
import { ensureLocalWorkspace } from '@/server/db/client';
import { applyMigrations } from '@/server/db/migration-state';
import { createRepositories } from '@/server/repositories';
import { createServices } from '@/server/services';
import { tempDir } from '@tests/support/libsql';
import {
  blueFarmSpec,
  commitReviewed,
  committed,
  createServiceHarness,
  moveCard,
  publishAndRefresh,
  trackDeck,
} from '@tests/support/services';

import { runImportCommand } from '../../scripts/import-local';

import { openRemote, remoteTarget, wipeRemoteDatabase } from './support';

beforeAll(async () => {
  await wipeRemoteDatabase();
  const handle = await openRemote();
  try {
    await applyMigrations(handle.db);
    await ensureLocalWorkspace(handle.db);
  } finally {
    handle.close();
  }
});

describe('pnpm import:local into a remote database', () => {
  it('imports a local installation’s history, identical, and skips it the second time', async () => {
    const path = join(tempDir('git-moxfield-remote-import-'), 'git-moxfield.db');
    const harness = await createServiceHarness({ databaseUrl: pathToFileURL(path).href });
    // A long primer makes a raw payload of a realistic size.
    const spec = blueFarmSpec({
      publicId: 'RemoteImportDeck000001',
      primer: Array.from({ length: 4000 }, (_, line) => `Line ${line} of a long primer.`).join('\n'),
    });
    const deckId = await trackDeck(harness, spec);
    committed(await commitReviewed(harness, deckId, 'Initial version', ['stable']));
    await publishAndRefresh(
      harness,
      deckId,
      moveCard({ ...spec, version: 2 }, 'Dress Down', 'mainboard', 'considering'),
    );
    committed(await commitReviewed(harness, deckId, 'Cut Dress Down'));
    await harness.services.setNote(deckId, 2, 'Testing');

    const remote = await openRemote();
    try {
      const user = await createRepositories(remote.db).users.create({ displayName: 'Jaakko', role: 'admin' });
      const { url, authToken } = remoteTarget();
      const config = parseConfig({ TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: authToken });
      const run = async () => {
        const out: string[] = [];
        const err: string[] = [];
        const code = await runImportCommand(['--from', path, '--to-user', 'Jaakko'], {
          config,
          io: { out: (line) => out.push(line), err: (line) => err.push(line) },
        });
        return { code, out, err };
      };

      const first = await run();
      expect(first.err).toEqual([]);
      expect(first.code).toBe(0);
      expect(first.out.at(-1)).toBe('Done: imported 1 deck (2 versions).');

      const target = createServices({
        db: remote.db,
        sources: harness.sources,
        config: harness.config,
        workspaceId: user.workspaceId,
        now: harness.clock.now,
      });
      expect(await target.listVersions(deckId)).toEqual(await harness.services.listVersions(deckId));
      expect((await target.getVersion(deckId, 2))?.notes.map((note) => note.data)).toEqual([
        { text: 'Testing' },
      ]);
      expect((await target.compare(deckId, 'v1', 'v2'))?.diff).toEqual(
        (await harness.services.compare(deckId, 'v1', 'v2'))?.diff,
      );
      expect(await remote.db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);

      const second = await run();
      expect(second.code).toBe(0);
      expect(second.out.at(-1)).toBe('Nothing to import: the target has every deck already.');
    } finally {
      remote.close();
    }
  });
});
