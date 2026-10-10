/**
 * Importing decks' history from another git-moxfield database (`pnpm import:local`, see
 * `scripts/import-local.ts`): typically a local installation's file, moved into the hosted
 * instance's Turso database under the account of the person whose decks they are.
 *
 * 1. {@link openSourceCopy}: the source file is copied and only the copy is opened (and
 *    migrated to this build's schema), so the source is never modified.
 * 2. {@link chooseSourceWorkspace}, {@link findTargetUser}, {@link selectSourceDecks}: whose
 *    decks, for whom, which ones.
 * 3. {@link planImport}: what the target has already; reads only (a dry run stops here).
 * 4. {@link runImport}: copies content, then each deck's history in one transaction.
 *
 * Copied are decks with their branches, versions (commit ids preserved: they are
 * content-addressed), snapshots, raw payloads, observations, version tags, notes, recorded
 * changes of Moxfield deck and the card facts of their cards. Not copied: users, sessions,
 * bookmarklet keys, links, invites and share links (they belong to an installation's
 * accounts, not to deck history).
 *
 * Idempotent: a deck the target already has with the same versions is skipped, content
 * that exists is not written again, and card facts merge by recency. A deck the target
 * workspace tracks with a different history is a conflict: the import refuses to start
 * unless told to skip such decks.
 */
export { HistoryImportError, isHistoryImportError } from './errors';
export {
  planImport,
  type DeckImportPlan,
  type ImportContent,
  type ImportCounts,
  type ImportDeck,
  type ImportEndpoints,
  type ImportPlan,
  type PlanImportOptions,
} from './plan';
export {
  batchBySize,
  runImport,
  TRANSFER_BATCH_BYTES,
  TRANSFER_BATCH_ROWS,
  type ImportProgress,
  type ImportResult,
  type RunImportOptions,
} from './run';
export {
  chooseSourceWorkspace,
  describeSourceWorkspace,
  findTargetUser,
  selectSourceDecks,
  type SourceWorkspace,
  type SourceWorkspaceChoice,
} from './selection';
export { copyDatabaseFiles, openSourceCopy, type SourceCopy } from './source-copy';
