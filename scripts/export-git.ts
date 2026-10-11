/**
 * Exports a deck's version history into a new Git repository, one commit per version.
 *
 *   pnpm export:git <deck id | Moxfield deck id | Moxfield deck URL> [outDir]
 *
 * `outDir` defaults to `export/<Moxfield deck id>` and must be new or empty: exports are
 * never updated in place. Reads the app's database (`TURSO_DATABASE_URL`, else
 * `DATABASE_PATH`, default `data/git-moxfield.db`), configured in the environment and
 * `.env*` files like the app. See `src/server/git-export.ts` for the repository layout.
 *
 * The command line acts for the operator, so it finds decks in every user's workspace.
 * When several users track the same Moxfield deck, it lists them and asks for the
 * git-moxfield deck id of the one to export.
 */
import { relative } from 'node:path';

import { pluralize } from '@/core/text';
import { DEFAULT_MOXFIELD_SITE_ORIGIN } from '@/integrations/moxfield/constants';
import { getConfig, type AppConfig } from '@/server/config';
import {
  defaultExportDirectory,
  exportDeckToGit,
  GitExportError,
  locateDecksForExport,
} from '@/server/git-export';
import { createRepositories, type DeckLocation, type Repositories } from '@/server/repositories';

import {
  describeConfiguredDatabase,
  describeFailure,
  isMissingDatabaseFile,
  openConfiguredDatabase,
} from './database';
import { runMain } from './cli';
import { loadEnvFiles } from './load-env';

const USAGE = 'Usage: pnpm export:git <deck id | Moxfield deck id | Moxfield deck URL> [outDir]';

/** Quotes a path for copy-pasting into a POSIX shell when it needs quoting. */
function shellQuote(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

function describeDeck(deck: DeckLocation): string {
  return `  ${deck.externalId}  ${deck.name}  (id ${deck.deckId}, ${deck.ownerDisplayName ?? 'no owner'})`;
}

async function printTrackedDecks(repos: Repositories): Promise<void> {
  const decks = await repos.workspaces.locateAllDecks();
  if (decks.length === 0) {
    console.error('No decks are tracked yet.');
    return;
  }
  console.error('Tracked decks:');
  for (const deck of decks) console.error(describeDeck(deck));
}

async function run(
  config: AppConfig,
  reference: string,
  outDirArgument: string | undefined,
): Promise<number> {
  if (isMissingDatabaseFile(config)) {
    console.error(
      `No git-moxfield database: the ${describeConfiguredDatabase(config)} does not exist. ` +
        'Set DATABASE_PATH (or TURSO_DATABASE_URL) to the database to export from.',
    );
    return 1;
  }
  const database = await openConfiguredDatabase(config);
  const { db } = database;
  try {
    const system = createRepositories(db);
    const matches = await locateDecksForExport(system, reference, {
      siteOrigins: [...new Set([config.moxfieldSiteOrigin, DEFAULT_MOXFIELD_SITE_ORIGIN])],
    });
    const [match, ...others] = matches;
    if (match === undefined) {
      console.error(`No tracked deck matches ${JSON.stringify(reference)}.`);
      await printTrackedDecks(system);
      return 1;
    }
    if (others.length > 0) {
      console.error(`Several users track ${JSON.stringify(reference)}. Export one by its deck id:`);
      for (const deck of matches) console.error(describeDeck(deck));
      return 1;
    }

    // Everything below reads the deck's own workspace only.
    const repos = createRepositories(db, { workspaceId: match.workspaceId });
    const deck = await repos.decks.getById(match.deckId);
    if (!deck) throw new Error(`Deck ${match.deckId} vanished`);
    const result = await exportDeckToGit({
      repos,
      deckId: deck.id,
      outDir: outDirArgument ?? defaultExportDirectory(deck),
    });
    const count = result.versions.length;
    console.log(`Exported ${pluralize(count, 'version')} of "${deck.name}" to ${result.outDir}`);
    console.log('Every version is tagged v<N>; version tags become <tag>/v<N>.');
    const labels = result.versions.flatMap((version) => version.tags.filter((tag) => tag.includes('/')));
    if (labels.length > 0) console.log(`Version tags: ${labels.join(', ')}`);
    for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
    const shown = relative(process.cwd(), result.outDir) || '.';
    console.log(
      `\nInspect it with:\n  git -C ${shellQuote(shown.startsWith('..') ? result.outDir : shown)} log --oneline --decorate`,
    );
    return 0;
  } catch (error) {
    if (error instanceof GitExportError) {
      console.error(`Export failed: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    database.close();
  }
}

async function main(argv: readonly string[]): Promise<number> {
  // pnpm forwards a literal `--` when users separate script arguments with it.
  const args = argv.filter((arg) => arg !== '--');
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const [reference, outDir, ...extra] = args;
  if (reference === undefined || extra.length > 0) {
    console.error(USAGE);
    return 2;
  }
  let config: AppConfig;
  try {
    loadEnvFiles();
    config = getConfig();
  } catch (error) {
    console.error(describeFailure(error));
    return 1;
  }
  try {
    return await run(config, reference, outDir);
  } catch (error) {
    console.error(`Export failed: ${describeFailure(error, config)}`);
    return 1;
  }
}

runMain('export:git', () => main(process.argv.slice(2)));
