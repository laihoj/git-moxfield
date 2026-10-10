/**
 * Carrying out an import plan (`./plan`), deck by deck, in short atomic steps so that no
 * transaction holds a remote database's write lock for long (Turso takes it from a
 * transaction that holds it for more than 5 s while another writer waits, ADR 0008):
 *
 * 1. the snapshots and raw payloads the target lacks, in batches of at most
 *    {@link TRANSFER_BATCH_BYTES} (content-addressed and invisible until referenced, so a
 *    failure here leaves nothing anyone sees, and running the import again completes it);
 * 2. the deck's history in one transaction (it appears complete, or not at all);
 * 3. the card facts of the deck's cards (latest facts win, so merging twice is harmless);
 * 4. a check that the target's version lineage, tags and notes are the source's.
 */
import 'server-only';

import { HistoryImportError } from './errors';
import type { DeckImportPlan, ImportEndpoints, ImportPlan } from './plan';

/** Most bytes of snapshot or raw payload values sent in one batch (one request remotely). */
export const TRANSFER_BATCH_BYTES = 2_000_000;

/** Most snapshots or raw payloads in one batch. */
export const TRANSFER_BATCH_ROWS = 50;

type ImportedDeck = Extract<DeckImportPlan, { action: 'import' }>;

export type ImportProgress =
  | { kind: 'copying'; deck: ImportedDeck; snapshots: number; rawBlobs: number; bytes: number }
  | { kind: 'imported'; deck: ImportedDeck; targetDeckId: string };

export interface RunImportOptions {
  /** Leave decks that conflict with the target as they are (otherwise the import refuses to start). */
  skipExisting: boolean;
  onProgress?: (event: ImportProgress) => void;
}

export interface ImportResult {
  /** Imported decks with their id in the target. */
  imported: { plan: ImportedDeck; targetDeckId: string }[];
  /** Decks the target had already (skipped; their card facts were merged again). */
  alreadyImported: Extract<DeckImportPlan, { action: 'skip' }>[];
  /** Conflicting decks left as they are (`skipExisting`). */
  skipped: Extract<DeckImportPlan, { action: 'conflict' }>[];
}

/**
 * Groups hashes into batches of at most {@link TRANSFER_BATCH_ROWS} rows and
 * {@link TRANSFER_BATCH_BYTES} bytes (a single larger row goes alone).
 */
export function batchBySize(hashes: readonly string[], sizes: ReadonlyMap<string, number>): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const hash of hashes) {
    const size = sizes.get(hash) ?? 0;
    if (
      current.length > 0 &&
      (current.length >= TRANSFER_BATCH_ROWS || bytes + size > TRANSFER_BATCH_BYTES)
    ) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(hash);
    bytes += size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function total(hashes: readonly string[], sizes: ReadonlyMap<string, number>): number {
  return hashes.reduce((sum, hash) => sum + (sizes.get(hash) ?? 0), 0);
}

/** Step 1: the snapshots and raw payloads the target lacks. */
async function copyContent(endpoints: ImportEndpoints, plan: ImportedDeck): Promise<void> {
  const { source, target } = endpoints;
  const { snapshots, rawBlobs, snapshotBytes, rawBlobBytes } = plan.content;
  for (const batch of batchBySize(snapshots, snapshotBytes)) {
    await target.historyTransfer.insertSnapshots(await source.historyTransfer.readSnapshots(batch));
  }
  for (const batch of batchBySize(rawBlobs, rawBlobBytes)) {
    await target.historyTransfer.insertRawBlobs(await source.historyTransfer.readRawBlobs(batch));
  }
}

/** Step 3: the card facts of the deck's cards, from the source workspace's catalog. */
async function mergeCardFacts(endpoints: ImportEndpoints, cardKeys: readonly string[]): Promise<void> {
  const facts = await endpoints.source.historyTransfer.readCatalog(cardKeys);
  await endpoints.target.historyTransfer.mergeCatalog(facts);
}

/** Step 4: the target holds exactly the source's history of the deck. */
async function verifyImported(
  endpoints: ImportEndpoints,
  plan: ImportedDeck,
  targetDeckId: string,
): Promise<void> {
  const [sourceLineage, targetLineage, written] = await Promise.all([
    endpoints.source.commits.lineage(plan.deck.id),
    endpoints.target.commits.lineage(targetDeckId),
    endpoints.target.historyTransfer.readDeckHistory(targetDeckId),
  ]);
  const ids = (lineage: readonly { id: string }[]): string => lineage.map((commit) => commit.id).join(',');
  const problems: string[] = [];
  if (ids(sourceLineage) !== ids(targetLineage)) problems.push('the version lineage differs');
  if (written === null) problems.push('the deck is missing');
  else {
    if (written.commits.length !== plan.counts.versions) problems.push('versions are missing');
    if (written.versionTags.length !== plan.counts.tags) problems.push('tags are missing');
    if (written.commitNotes.length !== plan.counts.notes) problems.push('notes are missing');
    if (written.observations.length !== plan.counts.observations) problems.push('observations are missing');
  }
  if (problems.length > 0) {
    throw new HistoryImportError(
      `“${plan.deck.name}” was imported, but checking it failed: ${problems.join(', ')}. Look at the deck in ` +
        'git-moxfield; stop tracking it there and import it again if it is not right.',
    );
  }
}

/**
 * Carries out `plan` (see the module documentation). Decks are imported one after another;
 * when one fails, the decks before it stay imported and running the import again picks up
 * where it stopped (imported decks are then `already-imported`).
 *
 * @throws {HistoryImportError} when the plan has conflicts and `skipExisting` is not set
 *   (nothing is written), or an imported deck fails its check.
 * @throws {RepositoryError} `conflict` when the target changed since planning (someone
 *   tracked the deck meanwhile): run the import again.
 */
export async function runImport(
  endpoints: ImportEndpoints,
  plan: ImportPlan,
  options: RunImportOptions,
): Promise<ImportResult> {
  const result: ImportResult = { imported: [], alreadyImported: [], skipped: [] };
  for (const deck of plan.decks) {
    if (deck.action === 'conflict') result.skipped.push(deck);
    if (deck.action === 'skip') result.alreadyImported.push(deck);
  }
  if (result.skipped.length > 0 && !options.skipExisting) {
    throw new HistoryImportError(
      `${result.skipped.length} deck${result.skipped.length === 1 ? ' conflicts' : 's conflict'} with the target; nothing was imported.`,
    );
  }

  for (const deck of plan.decks) {
    if (deck.action !== 'import') continue;
    const { snapshots, rawBlobs, snapshotBytes, rawBlobBytes } = deck.content;
    options.onProgress?.({
      kind: 'copying',
      deck,
      snapshots: snapshots.length,
      rawBlobs: rawBlobs.length,
      bytes: total(snapshots, snapshotBytes) + total(rawBlobs, rawBlobBytes),
    });
    await copyContent(endpoints, deck);
    await endpoints.target.historyTransfer.insertDeckHistory(deck.rows);
    const targetDeckId = deck.rows.deck.id;
    await mergeCardFacts(endpoints, deck.cardKeys);
    await verifyImported(endpoints, deck, targetDeckId);
    result.imported.push({ plan: deck, targetDeckId });
    options.onProgress?.({ kind: 'imported', deck, targetDeckId });
  }
  // An earlier run may have stopped between a deck's history and its card facts.
  for (const deck of result.alreadyImported) await mergeCardFacts(endpoints, deck.cardKeys);
  return result;
}
