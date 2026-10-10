/**
 * Planning an import: for every source deck, what the target already has and what the
 * import would do (import it, skip it, or refuse it), computed from reads only. A dry run
 * prints the plan; a real run carries it out (`./run`).
 */
import 'server-only';

import { randomUUID } from 'node:crypto';

import {
  assertCommitsContentAddressed,
  deckReferences,
  isRepositoryError,
  MAX_STORED_VALUE_BYTES,
  type DeckHistoryRows,
  type DeckRecord,
  type Repositories,
  type TransferIdKind,
} from '@/server/repositories';

import { HistoryImportError } from './errors';
import { batchBySize } from './run';

/** The repositories an import works with. */
export interface ImportEndpoints {
  /** On the source copy, bound to the source workspace. */
  source: Repositories;
  /** On the target database, bound to the target user's workspace. */
  target: Repositories;
  /** The target user's workspace (the one `target` is bound to). */
  targetWorkspaceId: string;
}

/** A source deck, as the plan names it. */
export interface ImportDeck {
  /** The deck's id in the source. */
  id: string;
  source: string;
  externalId: string;
  name: string;
}

/** What a deck's history holds. */
export interface ImportCounts {
  versions: number;
  tags: number;
  notes: number;
  observations: number;
  /** Recorded changes of Moxfield deck. */
  relinks: number;
}

/** Content-addressed rows the target lacks, to copy before the deck's history. */
export interface ImportContent {
  snapshots: string[];
  rawBlobs: string[];
  /** Stored sizes, for batching the copies and for the summary. */
  snapshotBytes: Map<string, number>;
  rawBlobBytes: Map<string, number>;
}

export type DeckImportPlan =
  | {
      action: 'import';
      deck: ImportDeck;
      counts: ImportCounts;
      /** The history as it will be written: the target workspace's, with taken ids replaced. */
      rows: DeckHistoryRows;
      /** Number of row ids (deck, branches, observations, notes) replaced because they were taken. */
      replacedIds: number;
      content: ImportContent;
      /** Card keys of every snapshot the history references (for the card catalog). */
      cardKeys: string[];
    }
  | {
      action: 'skip';
      reason: 'already-imported';
      deck: ImportDeck;
      counts: ImportCounts;
      /** The target's copy of the deck. */
      targetDeckId: string;
      cardKeys: string[];
    }
  | {
      action: 'conflict';
      /**
       * `different-history`: the target workspace tracks the same Moxfield deck with other
       * versions. `history-elsewhere`: the versions are stored in the target already, in
       * another deck (one that changed Moxfield deck since) or another user's workspace.
       */
      reason: 'different-history' | 'history-elsewhere';
      deck: ImportDeck;
      counts: ImportCounts;
      message: string;
      targetDeckId: string | null;
    };

export interface ImportPlan {
  decks: DeckImportPlan[];
}

export interface PlanImportOptions {
  /** Id generator for rows whose id is taken in the target. Default: `crypto.randomUUID`. */
  newId?: () => string;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function countsOf(rows: DeckHistoryRows): ImportCounts {
  return {
    versions: rows.commits.length,
    tags: rows.versionTags.length,
    notes: rows.commitNotes.length,
    observations: rows.observations.length,
    relinks: rows.relinks.length,
  };
}

/** Hashes of the snapshots and raw payloads the history references. */
function contentOf(rows: DeckHistoryRows): { snapshots: string[]; rawBlobs: string[] } {
  const snapshots = new Set<string>();
  const rawBlobs = new Set<string>();
  for (const row of [...rows.commits, ...rows.observations]) {
    snapshots.add(row.snapshotHash);
    if (row.rawBlobHash !== null) rawBlobs.add(row.rawBlobHash);
  }
  return { snapshots: [...snapshots], rawBlobs: [...rawBlobs] };
}

/**
 * Checks what will be copied before anything is: the versions are content-addressed, their
 * content is stored in the source, intact (it matches its hashes and this version reads
 * it), and no value is larger than a remote database accepts.
 */
async function verifySource(source: Repositories, rows: DeckHistoryRows): Promise<void> {
  const what = `“${rows.deck.name}” (${rows.deck.source}:${rows.deck.externalId})`;
  try {
    assertCommitsContentAddressed(rows.commits, deckReferences(rows.deck, rows.relinks));
  } catch (error) {
    if (!isRepositoryError(error)) throw error;
    throw new HistoryImportError(`The source's ${what} is damaged: ${error.message}.`, { cause: error });
  }
  const content = contentOf(rows);
  const [snapshotBytes, rawBlobBytes] = await Promise.all([
    source.historyTransfer.snapshotSizes(content.snapshots),
    source.historyTransfer.rawBlobSizes(content.rawBlobs),
  ]);
  for (const [hashes, sizes, kind] of [
    [content.snapshots, snapshotBytes, 'snapshot'],
    [content.rawBlobs, rawBlobBytes, 'raw payload'],
  ] as const) {
    for (const hash of hashes) {
      const bytes = sizes.get(hash);
      if (bytes === undefined) {
        throw new HistoryImportError(`The source's ${what} is damaged: its ${kind} ${hash} is missing.`);
      }
      if (bytes > MAX_STORED_VALUE_BYTES) {
        throw new HistoryImportError(
          `The source's ${what} has a ${kind} of ${bytes.toLocaleString('en-US')} bytes, more than git-moxfield ` +
            `stores (${MAX_STORED_VALUE_BYTES.toLocaleString('en-US')} bytes; a remote database refuses larger values).`,
        );
      }
    }
  }
  // Reading verifies (hashes, decoding); a batch at a time, nothing is kept.
  try {
    for (const batch of batchBySize(content.snapshots, snapshotBytes)) {
      await source.historyTransfer.readSnapshots(batch);
    }
    for (const batch of batchBySize(content.rawBlobs, rawBlobBytes)) {
      await source.historyTransfer.readRawBlobs(batch);
    }
  } catch (error) {
    if (!isRepositoryError(error)) throw error;
    throw new HistoryImportError(`The source's ${what} is damaged: ${error.message}.`, { cause: error });
  }
}

/** Replaces the ids of `rows` that the target uses already; returns the rows and how many ids changed. */
async function withFreeIds(
  target: Repositories,
  rows: DeckHistoryRows,
  newId: () => string,
): Promise<{ rows: DeckHistoryRows; replaced: number }> {
  const kinds: [TransferIdKind, string[]][] = [
    ['deck', [rows.deck.id]],
    ['branch', rows.branches.map((row) => row.id)],
    ['observation', rows.observations.map((row) => row.id)],
    ['note', rows.commitNotes.map((row) => row.id)],
    ['relink', rows.relinks.map((row) => row.id)],
  ];
  const taken = await Promise.all(kinds.map(([kind, ids]) => target.historyTransfer.takenIds(kind, ids)));
  const replacements = new Map<string, string>();
  taken.forEach((ids) => {
    for (const id of ids) replacements.set(id, newId());
  });
  const id = (value: string): string => replacements.get(value) ?? value;
  const deckId = id(rows.deck.id);
  return {
    replaced: replacements.size,
    rows: {
      // The fetch status described the source installation's attempts.
      deck: { ...rows.deck, id: deckId, lastFetchAttemptAt: null, lastFetchErrorJson: null },
      branches: rows.branches.map((row) => ({ ...row, id: id(row.id), deckId })),
      commits: rows.commits.map((row) => ({ ...row, deckId, branchId: id(row.branchId) })),
      observations: rows.observations.map((row) => ({ ...row, id: id(row.id), deckId })),
      versionTags: rows.versionTags,
      commitNotes: rows.commitNotes.map((row) => ({ ...row, id: id(row.id) })),
      relinks: rows.relinks.map((row) => ({ ...row, id: id(row.id), deckId })),
    },
  };
}

async function planDeck(
  endpoints: ImportEndpoints,
  sourceDeck: DeckRecord,
  newId: () => string,
): Promise<DeckImportPlan> {
  const { source, target } = endpoints;
  const rows = await source.historyTransfer.readDeckHistory(sourceDeck.id);
  if (!rows) throw new Error(`Source deck ${sourceDeck.id} vanished while planning`);
  await verifySource(source, rows);
  const deck: ImportDeck = {
    id: rows.deck.id,
    source: rows.deck.source,
    externalId: rows.deck.externalId,
    name: rows.deck.name,
  };
  const counts = countsOf(rows);
  const content = contentOf(rows);
  const commitIds = rows.commits.map((commit) => commit.id);
  const cardKeys = await source.historyTransfer.cardKeysOf(content.snapshots);

  const tracked = await target.decks.getBySourceExternal(deck.source, deck.externalId);
  if (tracked) {
    const theirs = new Set((await target.commits.listForDeck(tracked.id)).map((commit) => commit.id));
    if (theirs.size === commitIds.length && commitIds.every((id) => theirs.has(id))) {
      return { action: 'skip', reason: 'already-imported', deck, counts, targetDeckId: tracked.id, cardKeys };
    }
    return {
      action: 'conflict',
      reason: 'different-history',
      deck,
      counts,
      targetDeckId: tracked.id,
      message:
        `The target's “${tracked.name}” tracks this Moxfield deck already, with a different history ` +
        `(${pluralize(theirs.size, 'version')} there, ${pluralize(commitIds.length, 'version')} here).`,
    };
  }

  const stored = await target.historyTransfer.locateCommits(commitIds);
  const [elsewhere] = stored;
  if (elsewhere) {
    const ours = elsewhere.workspaceId === endpoints.targetWorkspaceId;
    const holder = ours ? await target.decks.getById(elsewhere.deckId) : null;
    return {
      action: 'conflict',
      reason: 'history-elsewhere',
      deck,
      counts,
      targetDeckId: holder?.id ?? null,
      message: holder
        ? `Its versions are in the target's “${holder.name}” already, which follows ` +
          `${holder.source}:${holder.externalId} now (its Moxfield deck was changed).`
        : "Its versions are stored in another user's workspace of the target already (version ids are " +
          'unique per installation): this history was imported for someone else.',
    };
  }

  const { rows: written, replaced } = await withFreeIds(target, rows, newId);
  const [missingSnapshots, missingRawBlobs, snapshotBytes, rawBlobBytes] = await Promise.all([
    target.historyTransfer.missingSnapshots(content.snapshots),
    target.historyTransfer.missingRawBlobs(content.rawBlobs),
    source.historyTransfer.snapshotSizes(content.snapshots),
    source.historyTransfer.rawBlobSizes(content.rawBlobs),
  ]);
  return {
    action: 'import',
    deck,
    counts,
    rows: written,
    replacedIds: replaced,
    content: { snapshots: missingSnapshots, rawBlobs: missingRawBlobs, snapshotBytes, rawBlobBytes },
    cardKeys,
  };
}

/**
 * Plans importing `decks` (decks of the source workspace) into the target workspace. Reads
 * only. Verifies the source data on the way: a damaged deck (commit ids that do not match
 * their content, missing content) or a value too large to store refuses the whole import.
 *
 * @throws {HistoryImportError} for damaged or unstorable source data.
 */
export async function planImport(
  endpoints: ImportEndpoints,
  decks: readonly DeckRecord[],
  options: PlanImportOptions = {},
): Promise<ImportPlan> {
  const newId = options.newId ?? randomUUID;
  const planned: DeckImportPlan[] = [];
  // One deck at a time: remotely every read is a round trip, and the plan is small.
  for (const deck of decks) planned.push(await planDeck(endpoints, deck, newId));
  return { decks: planned };
}
