/**
 * Imports decks' history from another git-moxfield database, typically the SQLite file of
 * a local installation, into the configured database (Turso for the hosted instance:
 * `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`; else the file at `DATABASE_PATH`), into the
 * workspace of one of its users:
 *
 *   pnpm import:local -- --from <sqlite file> --to-user <user id | display name>
 *       [--from-workspace <workspace id | user id | display name>]
 *       [--deck <Moxfield deck id | Moxfield URL | deck id>]... [--skip-existing] [--dry-run]
 *
 * - The source file is never opened: it is copied (with its write-ahead log) to a private
 *   temporary directory, and the copy is read (and migrated to this version's schema, so a
 *   database from any earlier version works). The copy is deleted afterwards.
 * - Source workspace: the decks of the source's `local` workspace (where an installation
 *   from before accounts keeps its decks; its first admin adopts it when claiming), or else
 *   of its first admin. `--from-workspace` chooses another one.
 * - Copied per deck: the deck, its branches, versions (commit ids preserved), snapshots,
 *   raw payloads, observations, version tags, notes, recorded Moxfield deck changes, and
 *   the card facts of its cards. Users, sessions, keys and links are never copied.
 * - Re-running is safe: decks the target has with the same versions are skipped. A deck
 *   the target user tracks with a different history makes the import refuse to start
 *   (nothing is written) unless `--skip-existing` leaves such decks out.
 * - `--dry-run` prints what would happen and writes nothing.
 *
 * Exit codes: 0 done (or nothing to do), 1 refused or failed, 2 wrong usage. See
 * `src/server/history-import` for how the import works.
 */
import { resolve } from 'node:path';
import { pluralize } from '@/core/text';
import { formatBytes } from '@/lib/format';
import type { AppConfig } from '@/server/config';
import type { Db } from '@/server/db/client';
import { databaseFileOf, type LibsqlDatabase } from '@/server/db/libsql';
import { describeDeckRef, operatorSiteOrigins } from '@/server/deck-reference';
import {
  chooseSourceWorkspace,
  describeSourceWorkspace,
  findTargetUser,
  isHistoryImportError,
  openSourceCopy,
  planImport,
  runImport,
  selectSourceDecks,
  type DeckImportPlan,
  type ImportCounts,
  type SourceCopy,
  type SourceWorkspaceChoice,
} from '@/server/history-import';
import { createRepositories, isRepositoryError } from '@/server/repositories';

import {
  consoleIO,
  isEntryPoint,
  parseArgsOrUsage,
  runMain,
  sameFile,
  scriptArgs,
  UsageError,
  type CommandIO,
} from './cli';
import {
  describeConfiguredDatabase,
  isMissingDatabaseFile,
  loadConfigOrReport,
  openConfiguredDatabaseOrReport,
} from './database';

export const USAGE = `Usage: pnpm import:local -- --from <sqlite file> --to-user <user id | display name> [options]

Imports deck history from another git-moxfield database (e.g. a local installation's
data/git-moxfield.db) into the configured database (TURSO_DATABASE_URL, else DATABASE_PATH).
The source file is only read through a temporary copy.

Options:
  --from <file>                 The source database file (required)
  --to-user <id | name>         The user of the configured database who receives the decks (required)
  --from-workspace <id | name>  Source workspace (default: "local", else the source's first admin's)
  --deck <id | URL>             Import only this deck (Moxfield id, Moxfield URL or deck id); repeatable
  --skip-existing               Leave out decks the user tracks with a different history
  --dry-run                     Show what would be imported; write nothing`;

export interface ImportCommandDependencies {
  config: AppConfig;
  io: CommandIO;
  /**
   * The target database, already open, and how to name it (tests). Default: the configured
   * database, opened like the app opens it (a dry run only checks that it is migrated,
   * writing nothing).
   */
  target?: { db: Db; description: string };
  /** Id generator for rows whose id is taken in the target. Default: random UUIDs. */
  newId?: () => string;
}

interface ImportArguments {
  from: string;
  toUser: string;
  fromWorkspace: string | undefined;
  decks: string[];
  skipExisting: boolean;
  dryRun: boolean;
}

function parseArguments(argv: readonly string[]): ImportArguments | 'help' {
  const { args, help } = scriptArgs(argv);
  if (help) return 'help';
  const { values } = parseArgsOrUsage({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      from: { type: 'string' },
      'to-user': { type: 'string' },
      'from-workspace': { type: 'string' },
      deck: { type: 'string', multiple: true },
      'skip-existing': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const from = values.from?.trim() ?? '';
  const toUser = values['to-user']?.trim() ?? '';
  if (from === '') throw new UsageError('--from is required: the database file to import from.');
  if (toUser === '') throw new UsageError('--to-user is required: who receives the decks.');
  return {
    from,
    toUser,
    fromWorkspace: values['from-workspace'],
    decks: values.deck ?? [],
    skipExisting: values['skip-existing'],
    dryRun: values['dry-run'],
  };
}

function describeCounts(counts: ImportCounts): string {
  const parts = [pluralize(counts.versions, 'version')];
  if (counts.tags > 0) parts.push(pluralize(counts.tags, 'tag'));
  if (counts.notes > 0) parts.push(pluralize(counts.notes, 'note'));
  if (counts.observations > 0) parts.push(pluralize(counts.observations, 'observation'));
  if (counts.relinks > 0) parts.push(pluralize(counts.relinks, 'Moxfield deck change'));
  return parts.join(', ');
}

function describePlan(plan: DeckImportPlan): string {
  switch (plan.action) {
    case 'import':
      return `  import    ${describeDeckRef(plan.deck)}: ${describeCounts(plan.counts)}`;
    case 'skip':
      return `  skip      ${describeDeckRef(plan.deck)}: already imported (${pluralize(plan.counts.versions, 'version')})`;
    case 'conflict':
      return `  CONFLICT  ${describeDeckRef(plan.deck)}: ${plan.message}`;
  }
}

const CHOICE_REASONS: Record<SourceWorkspaceChoice['reason'], string> = {
  named: 'chosen with --from-workspace',
  local: 'the local workspace, where an installation from before accounts keeps its decks',
  'first-admin': "the first admin's workspace",
};

async function importHistory(
  args: ImportArguments,
  deps: ImportCommandDependencies,
  source: SourceCopy,
  target: { db: Db; description: string },
): Promise<number> {
  const { io, config } = deps;
  io.out(`Source: ${resolve(args.from)} (read from a temporary copy; the file itself is not changed)`);
  if (source.migrated.length > 0) {
    io.out(`  The copy was brought up to this version's schema (${source.migrated.join(', ')}).`);
  }
  const choice = await chooseSourceWorkspace(createRepositories(source.database.db), args.fromWorkspace);
  io.out(`  Reading ${describeSourceWorkspace(choice.workspace)}: ${CHOICE_REASONS[choice.reason]}.`);
  for (const other of choice.others) {
    io.out(`  Not read: ${describeSourceWorkspace(other)} (import it with --from-workspace ${other.id})`);
  }
  const sourceRepos = createRepositories(source.database.db, { workspaceId: choice.workspace.id });
  const decks = await selectSourceDecks(sourceRepos, args.decks, operatorSiteOrigins(config));

  const user = await findTargetUser(createRepositories(target.db), args.toUser);
  io.out(
    `Target: ${user.displayName} (user ${user.id}, ${user.role}${user.disabledAt === null ? '' : ', disabled'}) ` +
      `in the ${target.description}`,
  );
  const endpoints = {
    source: sourceRepos,
    target: createRepositories(target.db, {
      workspaceId: user.workspaceId,
      ...(deps.newId === undefined ? {} : { newId: deps.newId }),
    }),
    targetWorkspaceId: user.workspaceId,
  };
  const plan = await planImport(endpoints, decks, deps.newId === undefined ? {} : { newId: deps.newId });
  io.out('');
  if (plan.decks.length === 0) {
    io.out('The source workspace has no decks. Nothing to import.');
    return 0;
  }
  for (const deck of plan.decks) io.out(describePlan(deck));
  io.out('');

  const conflicts = plan.decks.filter((deck) => deck.action === 'conflict');
  const toImport = plan.decks.filter((deck) => deck.action === 'import');
  if (conflicts.length > 0 && !args.skipExisting) {
    io.err(
      `Nothing was imported: ${pluralize(conflicts.length, 'deck conflicts', 'decks conflict')} with what ` +
        `${user.displayName} has (see above). Either stop tracking the conflicting deck in git-moxfield ` +
        '(that deletes its history there) and run the import again, or pass --skip-existing to import the ' +
        'other decks and leave it as it is.',
    );
    return 1;
  }
  if (args.dryRun) {
    io.out(
      `Dry run: would import ${pluralize(toImport.length, 'deck')}` +
        `${conflicts.length > 0 ? ` and leave out ${pluralize(conflicts.length, 'conflicting deck')}` : ''}. ` +
        'Nothing was written.',
    );
    return 0;
  }
  if (toImport.length === 0) {
    // Merges the card facts of decks imported before, in case a run stopped before them.
    await runImport(endpoints, plan, { skipExisting: args.skipExisting });
    io.out(
      conflicts.length === 0
        ? 'Nothing to import: the target has every deck already.'
        : `Nothing to import: the target has the other decks already; ${pluralize(conflicts.length, 'conflicting deck')} left out.`,
    );
    return 0;
  }

  const result = await runImport(endpoints, plan, {
    skipExisting: args.skipExisting,
    onProgress: (event) => {
      if (event.kind === 'copying') {
        io.out(
          `Importing ${describeDeckRef(event.deck.deck)}: copying ${pluralize(event.snapshots, 'snapshot')} and ` +
            `${pluralize(event.rawBlobs, 'raw payload')} (${formatBytes(event.bytes)})…`,
        );
      } else {
        io.out(`  Imported as deck ${event.targetDeckId}; versions, tags and notes checked.`);
      }
    },
  });
  const versions = result.imported.reduce((sum, deck) => sum + deck.plan.counts.versions, 0);
  const parts = [`imported ${pluralize(result.imported.length, 'deck')} (${pluralize(versions, 'version')})`];
  if (result.alreadyImported.length > 0) parts.push(`${result.alreadyImported.length} already imported`);
  if (result.skipped.length > 0)
    parts.push(`${pluralize(result.skipped.length, 'conflicting deck')} left out`);
  io.out(`Done: ${parts.join('; ')}.`);
  return 0;
}

/** Runs `pnpm import:local`. @returns the process exit code. */
export async function runImportCommand(
  argv: readonly string[],
  deps: ImportCommandDependencies,
): Promise<number> {
  const { io, config } = deps;
  let args: ImportArguments;
  try {
    const parsed = parseArguments(argv);
    if (parsed === 'help') {
      io.out(USAGE);
      return 0;
    }
    args = parsed;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(`${error.message}\n\n${USAGE}`);
    return 2;
  }

  let ownTarget: LibsqlDatabase | undefined;
  let source: SourceCopy | undefined;
  try {
    let target = deps.target;
    if (target === undefined) {
      const targetFile = databaseFileOf(config.database.url);
      if (targetFile !== undefined && sameFile(targetFile, args.from)) {
        io.err(`${args.from} is the configured database itself; import from another database file.`);
        return 1;
      }
      if (isMissingDatabaseFile(config)) {
        io.err(
          `There is no git-moxfield database at the ${describeConfiguredDatabase(config)}. Set ` +
            'TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN), or DATABASE_PATH, to the database to import into.',
        );
        return 1;
      }
      ownTarget =
        (await openConfiguredDatabaseOrReport(config, io, { verifyOnly: args.dryRun })) ?? undefined;
      if (ownTarget === undefined) return 1;
      target = { db: ownTarget.db, description: describeConfiguredDatabase(config) };
    }
    source = await openSourceCopy(resolve(args.from));
    return await importHistory(args, deps, source, target);
  } catch (error) {
    if (isHistoryImportError(error)) {
      io.err(error.message);
      return 1;
    }
    if (isRepositoryError(error, 'conflict')) {
      io.err(
        `The target changed while importing (${error.message}). Run the import again: what was imported ` +
          'is kept and skipped.',
      );
      return 1;
    }
    throw error;
  } finally {
    source?.dispose();
    ownTarget?.close();
  }
}

async function main(): Promise<number> {
  const config = loadConfigOrReport(consoleIO);
  return config === null ? 1 : runImportCommand(process.argv.slice(2), { config, io: consoleIO });
}

// Run only as a script (`pnpm import:local`), not when imported by tests.
if (isEntryPoint(import.meta.url)) runMain('import:local', main);
