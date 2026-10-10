/**
 * Exports a deck's version history into a new Git repository, one commit per version.
 *
 *   pnpm export:git <deck id | Moxfield deck id | Moxfield deck URL> [outDir]
 *
 * `outDir` defaults to `export/<Moxfield deck id>` and must be new or empty: exports are
 * never updated in place. Reads `DATABASE_PATH` (default `data/git-moxfield.db`) from the
 * environment and `.env*` files, like the app. See
 * `src/server/git-export.ts` for the repository layout.
 */
import { existsSync } from 'node:fs';
import { relative } from 'node:path';

import { DEFAULT_MOXFIELD_SITE_ORIGIN } from '@/integrations/moxfield/constants';
import { getConfig } from '@/server/config';
import { openDatabase } from '@/server/db/client';
import {
  defaultExportDirectory,
  exportDeckToGit,
  findDeckForExport,
  GitExportError,
} from '@/server/git-export';
import { createRepositories, type Repositories } from '@/server/repositories';

import { loadEnvFiles } from './load-env';

const USAGE = 'Usage: pnpm export:git <deck id | Moxfield deck id | Moxfield deck URL> [outDir]';

/** Quotes a path for copy-pasting into a POSIX shell when it needs quoting. */
function shellQuote(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

function printTrackedDecks(repos: Repositories): void {
  const decks = repos.decks.list();
  if (decks.length === 0) {
    console.error('No decks are tracked yet.');
    return;
  }
  console.error('Tracked decks:');
  for (const deck of decks) console.error(`  ${deck.externalId}  ${deck.name}  (id ${deck.id})`);
}

function run(reference: string, outDirArgument: string | undefined): number {
  const config = getConfig();
  const databasePath = config.DATABASE_PATH;
  if (databasePath !== ':memory:' && !existsSync(databasePath)) {
    console.error(
      `No git-moxfield database at ${databasePath}. Set DATABASE_PATH to the database to export from.`,
    );
    return 1;
  }
  const db = openDatabase(databasePath);
  try {
    const repos = createRepositories(db);
    const deck = findDeckForExport(repos, reference, {
      siteOrigins: [...new Set([config.moxfieldSiteOrigin, DEFAULT_MOXFIELD_SITE_ORIGIN])],
    });
    if (!deck) {
      console.error(`No tracked deck matches ${JSON.stringify(reference)}.`);
      printTrackedDecks(repos);
      return 1;
    }

    const result = exportDeckToGit({
      repos,
      deckId: deck.id,
      outDir: outDirArgument ?? defaultExportDirectory(deck),
    });
    const count = result.versions.length;
    console.log(`Exported ${count} version${count === 1 ? '' : 's'} of "${deck.name}" to ${result.outDir}`);
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
    db.$client.close();
  }
}

function main(argv: readonly string[]): number {
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
  try {
    loadEnvFiles();
    return run(reference, outDir);
  } catch (error) {
    console.error(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
