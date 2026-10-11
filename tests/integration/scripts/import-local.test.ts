/**
 * `pnpm import:local` (scripts/import-local.ts): a local installation's database file is
 * imported into a user's workspace of another database. The history arrives identical
 * (versions, diffs, card history, notes, Git export), the source file is never touched,
 * re-running skips what exists, conflicts refuse the import, and a dry run writes nothing.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { parseConfig, type AppConfig } from '@/server/config';
import { openDatabase, type Db } from '@/server/db/client';
import { exportDeckToGit } from '@/server/git-export';
import { createRepositories, type Repositories } from '@/server/repositories';
import { createServices, type DeckServices } from '@/server/services';
import { baseDeckSpec, buildSnapshot } from '@tests/support/builders';
import { runCommand, type CommandRun } from '@tests/support/cli';
import { commitTestSnapshot, countRows, createTestDeck, openTestDatabase } from '@tests/support/db';
import { scratchDir } from '@tests/support/libsql';
import {
  blueFarmSpec,
  commitReviewed,
  committed,
  createServiceHarness,
  defined,
  moveCard,
  publishAndRefresh,
  trackDeck,
  twoVersionHistory,
  type ServiceHarness,
} from '@tests/support/services';

import { runImportCommand, USAGE } from '../../../scripts/import-local';

const gitAvailable = spawnSync('git', ['--version']).status === 0;

const MAIN = blueFarmSpec({ publicId: 'ImportBlueFarm00000001', name: 'Blue Farm' });
const OTHER = blueFarmSpec({ publicId: 'ImportOtherDeck0000002', name: 'Other deck' });
/** OTHER, deleted on Moxfield and made again. */
const OTHER_AGAIN = blueFarmSpec({ publicId: 'ImportOtherDeckNew0003', name: 'Other deck' });

interface Installation {
  /** The database file. */
  path: string;
  harness: ServiceHarness;
  decks: { main: string; other: string };
}

/**
 * A local installation's database file with history: Blue Farm with two versions (a tag,
 * a note) and an uncommitted working state; Other deck with a version before and one after
 * its Moxfield deck was deleted and made again.
 */
async function localInstallation(): Promise<Installation> {
  const path = join(scratchDir('git-moxfield-import-source-'), 'git-moxfield.db');
  const harness = await createServiceHarness({ databaseUrl: pathToFileURL(path).href });
  const { services, api, clock } = harness;

  const { deckId: main } = await twoVersionHistory(harness, { spec: MAIN, v1Tags: ['stable'] });
  await services.setNote(main, 1, 'Top 4 at locals');
  await publishAndRefresh(
    harness,
    main,
    moveCard({ ...MAIN, version: 3 }, 'Sol Ring', 'mainboard', 'sideboard'),
  );

  const other = await trackDeck(harness, OTHER);
  committed(await commitReviewed(harness, other, 'First'));
  api.decks.delete(OTHER.publicId);
  api.setDeck(OTHER_AGAIN);
  clock.advance(60);
  expect(await services.relinkDeck(other, OTHER_AGAIN.publicId)).toMatchObject({ ok: true });
  await publishAndRefresh(
    harness,
    other,
    moveCard({ ...OTHER_AGAIN, version: 2 }, 'Pyroclasm', 'sideboard', 'mainboard'),
  );
  committed(await commitReviewed(harness, other, 'Pyroclasm main'));
  return { path, harness, decks: { main, other } };
}

interface Target {
  db: Db;
  repos: Repositories;
  workspaceId: string;
  userId: string;
  services: DeckServices;
}

/** A hosted instance's database with a user `name` (and, for `config`-opened tests, its file). */
async function targetDatabase(harness: ServiceHarness, name = 'Jaakko', db?: Db): Promise<Target> {
  const target = db ?? (await openTestDatabase());
  const repos = createRepositories(target);
  const user = await repos.users.create({ displayName: name, role: 'admin' });
  return {
    db: target,
    repos,
    workspaceId: user.workspaceId,
    userId: user.id,
    services: createServices({
      db: target,
      sources: harness.sources,
      config: harness.config,
      workspaceId: user.workspaceId,
      now: harness.clock.now,
      logger: harness.logger,
    }),
  };
}

/**
 * Runs the command against `target` (named "in-memory database"), or else the database
 * `config` names. Without either, the configured database is a file in a scratch
 * directory: never a developer's database.
 */
async function runImport(
  argv: string[],
  options: { target?: Db; config?: AppConfig } = {},
): Promise<CommandRun> {
  return runCommand((io) =>
    runImportCommand(argv, {
      config:
        options.config ??
        parseConfig({ DATABASE_PATH: join(scratchDir('git-moxfield-import-config-'), 'never-opened.db') }),
      io,
      ...(options.target === undefined
        ? {}
        : { target: { db: options.target, description: 'in-memory database' } }),
    }),
  );
}

/** What a deck shows, minus what depends on the installation (fetch status, clocks). */
async function deckView(services: DeckServices, deckId: string) {
  const overview = defined(await services.getOverview(deckId));
  const versions = await services.listVersions(deckId);
  const details = await Promise.all(versions.map((version) => services.getVersion(deckId, version.sequence)));
  return {
    deck: {
      id: overview.id,
      name: overview.name,
      format: overview.format,
      externalId: overview.externalId,
      url: overview.url,
      status: overview.status,
      head: overview.head,
      working: overview.working,
      workingStats: overview.workingStats,
      versionCount: overview.versionCount,
      commanders: overview.commanders,
    },
    diff: overview.diff,
    relinks: overview.relinks,
    warnings: overview.warnings,
    versions,
    tags: await services.listTags(deckId),
    details: details.map((detail) => {
      const { deck: _deck, ...rest } = defined(detail);
      return rest;
    }),
    compare: (await services.compare(deckId, 'v1', 'working'))?.diff ?? null,
    cards: defined(await services.cardHistory(deckId, 'Dress Down')).history,
    search: await services.searchCards(deckId, 'ring'),
  };
}

/** Every file of the source's directory with its SHA-256: nothing may change it. */
function fingerprint(path: string): Record<string, string> {
  const dir = join(path, '..');
  return Object.fromEntries(
    readdirSync(dir).map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(join(dir, name)))
        .digest('hex'),
    ]),
  );
}

async function exportedCommits(repos: Repositories, deckId: string): Promise<string[]> {
  const result = await exportDeckToGit({ repos, deckId, outDir: scratchDir('git-moxfield-import-export-') });
  return result.versions.map((version) => version.gitCommit);
}

// Every test builds an installation file and runs whole imports (one also two Git exports):
// seconds each when the whole suite runs in parallel.
describe('pnpm import:local', { timeout: 30_000 }, () => {
  it('imports a local installation’s decks into a user’s workspace, history identical', async () => {
    const source = await localInstallation();
    const target = await targetDatabase(source.harness);
    const before = {
      main: await deckView(source.harness.services, source.decks.main),
      other: await deckView(source.harness.services, source.decks.other),
    };
    const sourceRepos = createRepositories(source.harness.db);
    const exports = gitAvailable
      ? {
          main: await exportedCommits(sourceRepos, source.decks.main),
          other: await exportedCommits(sourceRepos, source.decks.other),
        }
      : null;
    // Whatever the installation does with its file, the import must not change it. (It stays
    // open and idle here: a closed libSQL database finishes closing, checkpointing its WAL
    // into the file, only when the garbage collector finalizes its statements.)
    const untouched = fingerprint(source.path);

    const run = await runImport(['--', '--from', source.path, '--to-user', 'jaakko'], { target: target.db });
    expect(run.err).toEqual([]);
    expect(run.code).toBe(0);
    expect(run.out).toEqual([
      `Source: ${source.path} (read from a temporary copy; the file itself is not changed)`,
      '  Reading workspace local (no owner): 2 decks: the local workspace, where an installation from before accounts keeps its decks.',
      `Target: Jaakko (user ${target.userId}, admin) in the in-memory database`,
      '',
      expect.stringMatching(
        /^ {2}import {4}“Other deck” \(moxfield:ImportOtherDeckNew0003\): 2 versions, 2 observations, 1 Moxfield deck change$/,
      ),
      '  import    “Blue Farm” (moxfield:ImportBlueFarm00000001): 2 versions, 1 tag, 1 note, 2 observations',
      '',
      expect.stringMatching(
        /^Importing “Other deck” \(moxfield:ImportOtherDeckNew0003\): copying \d+ snapshots and \d+ raw payloads \(.+\)…$/,
      ),
      `  Imported as deck ${source.decks.other}; versions, tags and notes checked.`,
      expect.stringMatching(/^Importing “Blue Farm” \(moxfield:ImportBlueFarm00000001\): copying /),
      `  Imported as deck ${source.decks.main}; versions, tags and notes checked.`,
      'Done: imported 2 decks (4 versions).',
    ]);
    expect(fingerprint(source.path)).toEqual(untouched);

    // Integrity: references, and the same history in every view.
    expect(await target.db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
    expect((await target.services.listDecks()).map((deck) => deck.name).sort()).toEqual([
      'Blue Farm',
      'Other deck',
    ]);
    expect(await deckView(target.services, source.decks.main)).toEqual(before.main);
    expect(await deckView(target.services, source.decks.other)).toEqual(before.other);
    // The card facts came along (the type lines the diff shows).
    expect(Object.keys(defined(await target.services.getOverview(source.decks.main)).catalog)).not.toEqual(
      [],
    );
    if (exports !== null) {
      const targetRepos = createRepositories(target.db, { workspaceId: target.workspaceId });
      expect(await exportedCommits(targetRepos, source.decks.main)).toEqual(exports.main);
      expect(await exportedCommits(targetRepos, source.decks.other)).toEqual(exports.other);
    }

    // The imported history goes on: committing the working state makes v3.
    const v3 = committed(
      await target.services.commit(source.decks.main, {
        message: 'Sol Ring to the sideboard',
        expectedObservationId: defined(before.main.deck.working).id,
        expectedHeadCommitId: defined(before.main.deck.head).commitId,
      }),
    );
    expect(v3.sequence).toBe(3);
  });

  it('skips what exists when run again, and writes nothing on a dry run', async () => {
    const source = await localInstallation();
    const target = await targetDatabase(source.harness);
    const tables = [
      'decks',
      'commits',
      'snapshots',
      'raw_blobs',
      'observations',
      'version_tags',
      'commit_notes',
      'card_catalog',
      'deck_relinks',
    ];
    const counts = async (): Promise<Record<string, number>> =>
      Object.fromEntries(
        await Promise.all(
          tables.map(async (table): Promise<[string, number]> => [table, await countRows(target.db, table)]),
        ),
      );
    const empty = await counts();

    const dry = await runImport(['--from', source.path, '--to-user', target.userId, '--dry-run'], {
      target: target.db,
    });
    expect(dry.code).toBe(0);
    expect(dry.out.at(-1)).toBe('Dry run: would import 2 decks. Nothing was written.');
    expect(await counts()).toEqual(empty);

    expect(
      (await runImport(['--from', source.path, '--to-user', 'Jaakko'], { target: target.db })).code,
    ).toBe(0);
    const imported = await counts();
    const again = await runImport(['--from', source.path, '--to-user', 'Jaakko'], { target: target.db });
    expect(again.code).toBe(0);
    expect(again.out).toContain(
      '  skip      “Blue Farm” (moxfield:ImportBlueFarm00000001): already imported (2 versions)',
    );
    expect(again.out.at(-1)).toBe('Nothing to import: the target has every deck already.');
    expect(await counts()).toEqual(imported);
  });

  it('refuses a deck the user tracks with a different history, unless told to leave it out', async () => {
    const source = await localInstallation();
    const target = await targetDatabase(source.harness);
    // The user tracked Blue Farm on the hosted instance already and committed there.
    source.harness.api.setDeck(MAIN);
    const theirs = await target.services.trackDeck(`https://moxfield.com/decks/${MAIN.publicId}`);
    if (!theirs.ok) throw new Error(theirs.reason);
    const overview = defined(await target.services.getOverview(theirs.deckId));
    committed(
      await target.services.commit(theirs.deckId, {
        message: 'Hosted v1',
        expectedObservationId: defined(overview.working).id,
        expectedHeadCommitId: null,
      }),
    );
    const decksBefore = await countRows(target.db, 'decks');

    const refused = await runImport(['--from', source.path, '--to-user', 'Jaakko'], { target: target.db });
    expect(refused.code).toBe(1);
    expect(refused.out).toContain(
      "  CONFLICT  “Blue Farm” (moxfield:ImportBlueFarm00000001): The target's “Blue Farm” tracks this " +
        'Moxfield deck already, with a different history (1 version there, 2 versions here).',
    );
    expect(refused.err).toEqual([
      expect.stringMatching(
        /^Nothing was imported: 1 deck conflicts with what Jaakko has \(see above\)\. .*--skip-existing/,
      ),
    ]);
    expect(await countRows(target.db, 'decks')).toBe(decksBefore);

    const skipping = await runImport(['--from', source.path, '--to-user', 'Jaakko', '--skip-existing'], {
      target: target.db,
    });
    expect(skipping.code).toBe(0);
    expect(skipping.out.at(-1)).toBe('Done: imported 1 deck (2 versions); 1 conflicting deck left out.');
    expect((await target.services.listVersions(theirs.deckId)).map((version) => version.message)).toEqual([
      'Hosted v1',
    ]);
    expect(await target.services.getOverview(source.decks.other)).not.toBeNull();
  });

  it('imports only the decks asked for', async () => {
    const source = await localInstallation();
    const target = await targetDatabase(source.harness);
    const run = await runImport(
      ['--from', source.path, '--to-user', 'Jaakko', '--deck', `https://moxfield.com/decks/${MAIN.publicId}`],
      { target: target.db },
    );
    expect(run.code).toBe(0);
    expect((await target.services.listDecks()).map((deck) => deck.name)).toEqual(['Blue Farm']);

    const unknown = await runImport(['--from', source.path, '--to-user', 'Jaakko', '--deck', 'NoSuchDeck'], {
      target: target.db,
    });
    expect(unknown.code).toBe(1);
    expect(unknown.err.join('\n')).toContain('The source workspace has no deck "NoSuchDeck". Its decks:');
    expect(unknown.err.join('\n')).toContain(`  ${MAIN.publicId}  Blue Farm`);
  });

  it('refuses a history that is stored for another user already', async () => {
    const source = await localInstallation();
    const target = await targetDatabase(source.harness);
    const mikko = await targetDatabase(source.harness, 'Mikko', target.db);
    expect(
      (await runImport(['--from', source.path, '--to-user', 'Jaakko'], { target: target.db })).code,
    ).toBe(0);

    const run = await runImport(['--from', source.path, '--to-user', 'Mikko'], { target: target.db });
    expect(run.code).toBe(1);
    expect(run.out.filter((line) => line.startsWith('  CONFLICT'))).toEqual([
      expect.stringContaining("Its versions are stored in another user's workspace of the target already"),
      expect.stringContaining("Its versions are stored in another user's workspace of the target already"),
    ]);
    expect(await mikko.services.listDecks()).toEqual([]);
  });

  it('chooses the first admin’s workspace when the local one is empty, or the one named', async () => {
    const path = join(scratchDir('git-moxfield-import-source-'), 'claimed.db');
    const harness = await createServiceHarness({ databaseUrl: pathToFileURL(path).href });
    const admin = await harness.createUser('Admin', 'admin');
    const member = await harness.createUser('Member');
    harness.api.setDeck(MAIN);
    harness.api.setDeck(OTHER);
    expect(await admin.services.trackDeck(MAIN.publicId)).toMatchObject({ ok: true });
    expect(await member.services.trackDeck(OTHER.publicId)).toMatchObject({ ok: true });
    const target = await targetDatabase(harness);

    const first = await runImport(['--from', path, '--to-user', 'Jaakko'], { target: target.db });
    expect(first.code).toBe(0);
    expect(first.out.slice(1, 3)).toEqual([
      `  Reading workspace ${admin.user.workspaceId} (Admin, admin): 1 deck: the first admin's workspace.`,
      `  Not read: workspace ${member.user.workspaceId} (Member, member): 1 deck (import it with --from-workspace ${member.user.workspaceId})`,
    ]);
    expect((await target.services.listDecks()).map((deck) => deck.name)).toEqual(['Blue Farm']);

    const named = await runImport(['--from', path, '--to-user', 'Jaakko', '--from-workspace', 'member'], {
      target: target.db,
    });
    expect(named.code).toBe(0);
    expect(named.out[1]).toBe(
      `  Reading workspace ${member.user.workspaceId} (Member, member): 1 deck: chosen with --from-workspace.`,
    );
    expect((await target.services.listDecks()).map((deck) => deck.name).sort()).toEqual([
      'Blue Farm',
      'Other deck',
    ]);

    const unknown = await runImport(['--from', path, '--to-user', 'Jaakko', '--from-workspace', 'Nobody'], {
      target: target.db,
    });
    expect(unknown.code).toBe(1);
    expect(unknown.err.join('\n')).toContain('The source has no workspace or user "Nobody" with decks.');
    expect(unknown.err.join('\n')).toContain(`workspace ${member.user.workspaceId} (Member, member): 1 deck`);
  });

  it('reads a source the app still has open, including what is only in its write-ahead log', async () => {
    const source = await localInstallation();
    const target = await targetDatabase(source.harness);
    // The installation keeps running (its connection open), so the newest pages sit in its WAL.
    const untouched = fingerprint(source.path);
    expect(Object.keys(untouched)).toContain('git-moxfield.db-wal');
    const run = await runImport(['--from', source.path, '--to-user', 'Jaakko'], { target: target.db });
    expect(run.code).toBe(0);
    expect(fingerprint(source.path)).toEqual(untouched);
    expect(await target.services.listVersions(source.decks.main)).toEqual(
      await source.harness.services.listVersions(source.decks.main),
    );
  });

  it('brings a source from an earlier version up to date in its copy', async () => {
    const dir = scratchDir('git-moxfield-import-old-');
    const migrations = join(dir, 'drizzle');
    cpSync(join(process.cwd(), 'drizzle'), migrations, { recursive: true });
    const journalPath = join(migrations, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    writeFileSync(
      journalPath,
      JSON.stringify({
        ...journal,
        entries: journal.entries.filter((entry) => entry.tag !== '0009_deck_relinks'),
      }),
    );
    const path = join(dir, 'old.db');
    const old = await openDatabase({ url: pathToFileURL(path).href, migrationsFolder: migrations });
    const repos = createRepositories(old.db);
    const deck = await createTestDeck(repos, { externalId: 'OldSchemaDeck000000001', name: 'Old deck' });
    const v1 = await commitTestSnapshot(repos, deck, buildSnapshot(baseDeckSpec()));
    old.close();
    const harness = await createServiceHarness();
    const target = await targetDatabase(harness);

    const run = await runImport(['--from', path, '--to-user', 'Jaakko'], { target: target.db });
    expect(run.err).toEqual([]);
    expect(run.out[1]).toBe("  The copy was brought up to this version's schema (0009_deck_relinks).");
    expect((await target.services.listVersions(deck.id)).map((version) => version.commitId)).toEqual([v1.id]);
    // The source itself was not migrated.
    const reopened = await openDatabase({ url: pathToFileURL(path).href, migrationsFolder: migrations });
    expect(await reopened.db.all(sql`SELECT name FROM sqlite_master WHERE name = 'deck_relinks'`)).toEqual(
      [],
    );
    reopened.close();
  });

  it('opens the configured database like the app (a dry run only checks it)', async () => {
    const source = await localInstallation();
    const path = join(scratchDir('git-moxfield-import-target-'), 'hosted.db');
    const opened = await openDatabase({ url: pathToFileURL(path).href });
    await targetDatabase(source.harness, 'Jaakko', opened.db);
    opened.close();
    const config = parseConfig({ DATABASE_PATH: path });

    const dry = await runImport(['--from', source.path, '--to-user', 'Jaakko', '--dry-run'], { config });
    expect(dry.code).toBe(0);
    expect(dry.out.find((line) => line.startsWith('Target:'))).toMatch(
      /^Target: Jaakko \(user [\w-]+, admin\) in the database file .*hosted\.db$/,
    );
    const afterDryRun = await openDatabase({ url: pathToFileURL(path).href });
    expect(await countRows(afterDryRun.db, 'decks')).toBe(0);
    afterDryRun.close();

    const real = await runImport(['--from', source.path, '--to-user', 'Jaakko'], { config });
    expect(real.code).toBe(0);
    const reopened = await openDatabase({ url: pathToFileURL(path).href });
    expect(await countRows(reopened.db, 'decks')).toBe(2);
    reopened.close();

    const missing = await runImport(['--from', source.path, '--to-user', 'Jaakko'], {
      config: parseConfig({ DATABASE_PATH: join(path, '..', 'typo.db') }),
    });
    expect(missing.code).toBe(1);
    expect(missing.err[0]).toMatch(/^There is no git-moxfield database at the database file .*typo\.db\./);
  });

  it('refuses a damaged source before writing anything', async () => {
    const source = await localInstallation();
    const target = await targetDatabase(source.harness);
    // Damage one version's snapshot (bypassing the immutability trigger).
    const { db } = source.harness;
    const [v1] = await source.harness.repos.commits.lineage(source.decks.main);
    await db.run(sql`DROP TRIGGER snapshots_immutable_update`);
    await db.run(
      sql`UPDATE snapshots SET canonical_json = replace(canonical_json, 'Sol Ring', 'Sol Rang') WHERE hash = ${v1?.snapshotHash ?? ''}`,
    );

    const run = await runImport(['--from', source.path, '--to-user', 'Jaakko'], { target: target.db });
    expect(run.code).toBe(1);
    expect(run.err).toEqual([
      `The source's “Blue Farm” (moxfield:${MAIN.publicId}) is damaged: Snapshot ${v1?.snapshotHash ?? ''}: content does not match its hash.`,
    ]);
    expect(await countRows(target.db, 'decks')).toBe(0);
    expect(await countRows(target.db, 'snapshots')).toBe(0);
  });

  it('names the users of the target when the one asked for is unknown', async () => {
    const source = await localInstallation();
    const target = await targetDatabase(source.harness);
    const run = await runImport(['--from', source.path, '--to-user', 'Pekka'], { target: target.db });
    expect(run.code).toBe(1);
    expect(run.err.join('\n')).toContain('The target has no user "Pekka". Users:');
    expect(run.err.join('\n')).toContain(`  ${target.userId}  Jaakko  admin`);
  });
});

describe('pnpm import:local refusing', () => {
  it('prints usage for missing arguments', async () => {
    const run = await runImport(['--from', 'x.db']);
    expect(run.code).toBe(2);
    expect(run.err.join('\n')).toContain('--to-user is required');
    expect(run.err.join('\n')).toContain(USAGE);
  });

  it('refuses files that are missing, not SQLite or not git-moxfield databases', async () => {
    const harness = await createServiceHarness();
    const target = await targetDatabase(harness);
    const dir = scratchDir('git-moxfield-import-bad-');
    const notSqlite = join(dir, 'notes.txt');
    writeFileSync(notSqlite, 'hello, this is not a database\n'.repeat(100));
    const foreign = join(dir, 'other.db');
    const other = await openDatabase({ url: pathToFileURL(foreign).href });
    await other.db.run(sql`DROP TABLE ${sql.identifier('__drizzle_migrations')}`);
    other.close();

    const cases: [string, RegExp][] = [
      [join(dir, 'missing.db'), /There is no file at .*missing\.db\./],
      [dir, /is not a file\./],
      [notSqlite, /cannot be opened as a SQLite database/],
      [foreign, /is not a git-moxfield database\./],
    ];
    for (const [from, message] of cases) {
      const run = await runImport(['--from', from, '--to-user', 'Jaakko'], { target: target.db });
      expect(run.code, from).toBe(1);
      expect(run.err.join('\n')).toMatch(message);
    }
  });

  it('refuses to import the configured database into itself', async () => {
    const path = join(scratchDir('git-moxfield-import-self-'), 'app.db');
    (await openDatabase({ url: pathToFileURL(path).href })).close();
    const run = await runImport(['--from', path, '--to-user', 'Jaakko'], {
      config: parseConfig({ DATABASE_PATH: path }),
    });
    expect(run.code).toBe(1);
    expect(run.err).toEqual([
      `${path} is the configured database itself; import from another database file.`,
    ]);
  });
});
