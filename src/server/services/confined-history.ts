/**
 * The viewer scope's guard (ADR 0007): a view of the committed-history repositories
 * that only ever reads one deck.
 *
 * The repositories below it are bound to the deck's workspace, so nothing of another
 * workspace is reachable in the first place. Within that workspace, the view checks
 * every identifier that reaches the repositories:
 *
 * - every deck id must be the confined deck's;
 * - every commit returned must belong to the confined deck (this covers lookups by commit
 *   id, which are only workspace-scoped);
 * - commit ids (tags, notes, lineage) and snapshot hashes may only be those of commits the
 *   view has returned before, so no other deck's versions, notes or snapshots, and no
 *   working-state snapshot, can be read even by hash;
 * - card search is committed-only, whatever the caller asks for.
 *
 * Observations (the working state) are not part of {@link HistoryRepositories} at all.
 * A violated rule is a programming error, never a user's mistake: it throws
 * {@link DeckConfinementError} (a 500) instead of answering with data.
 *
 * The view remembers the commits it returned, so build one per request (it is cheap)
 * and let it go with the request. A refusal rejects the call (every method is `async`).
 */
import 'server-only';

import type { CommitRecord } from '@/server/repositories';

import type { HistoryRepositories } from './history';

/** A read outside the confined deck was attempted: a bug in the caller, refused. */
export class DeckConfinementError extends Error {
  override readonly name = 'DeckConfinementError';
}

/** Confines `repos` (bound to the deck's workspace) to the deck `deckId`. */
export function confineToDeck(repos: HistoryRepositories, deckId: string): HistoryRepositories {
  const commitIds = new Set<string>();
  const snapshotHashes = new Set<string>();

  const refuse = (what: string): never => {
    throw new DeckConfinementError(`${what} is outside the shared deck ${deckId}`);
  };
  /** A deck id the caller passes: must be the confined deck. */
  const deck = (id: string): string => (id === deckId ? id : refuse(`Deck ${id}`));
  /** A commit the repositories return: must be the deck's; remembered as reachable. */
  const commit = <T extends CommitRecord | null>(record: T): T => {
    if (record === null) return record;
    if (record.deckId !== deckId) refuse(`Commit ${record.id}`);
    commitIds.add(record.id);
    snapshotHashes.add(record.snapshotHash);
    return record;
  };
  const commitList = (records: CommitRecord[]): CommitRecord[] => {
    records.forEach(commit);
    return records;
  };
  /** A commit id the caller passes: must be one the view returned. */
  const knownCommit = (id: string): string => (commitIds.has(id) ? id : refuse(`Commit ${id}`));
  /** A snapshot hash the caller passes: must be one of a commit the view returned. */
  const knownSnapshot = (hash: string): string =>
    snapshotHashes.has(hash) ? hash : refuse(`Snapshot ${hash}`);

  // Every wrapper is `async`, so a refused identifier rejects the call like any other
  // failure instead of throwing synchronously.
  return {
    decks: {
      getById: async (id) => repos.decks.getById(deck(id)),
    },
    commits: {
      getById: async (id) => commit(await repos.commits.getById(id)),
      getBySequence: async (id, sequence) => commit(await repos.commits.getBySequence(deck(id), sequence)),
      findByIdPrefix: async (id, prefix) => commit(await repos.commits.findByIdPrefix(deck(id), prefix)),
      head: async (id) => commit(await repos.commits.head(deck(id))),
      lineage: async (id, fromCommitId) =>
        commitList(
          await repos.commits.lineage(
            deck(id),
            fromCommitId === undefined ? undefined : knownCommit(fromCommitId),
          ),
        ),
      listForDeck: async (id) => commitList(await repos.commits.listForDeck(deck(id))),
      count: async (id) => repos.commits.count(deck(id)),
    },
    snapshots: {
      get: async (hash) => repos.snapshots.get(knownSnapshot(hash)),
      getMany: async (hashes) => repos.snapshots.getMany([...hashes].map(knownSnapshot)),
    },
    tags: {
      listForCommit: async (id) => repos.tags.listForCommit(knownCommit(id)),
      listForCommits: async (ids) => repos.tags.listForCommits([...ids].map(knownCommit)),
      listForDeck: async (id) => repos.tags.listForDeck(deck(id)),
      commitsWithTag: async (id, tag) => commitList(await repos.tags.commitsWithTag(deck(id), tag)),
    },
    notes: {
      listForCommit: async (id) => repos.notes.listForCommit(knownCommit(id)),
    },
    cardIndex: {
      versionsContainingCard: async (id, key) => repos.cardIndex.versionsContainingCard(deck(id), key),
      searchCardsInDeck: async (id, query, limit) =>
        repos.cardIndex.searchCardsInDeck(deck(id), query, limit, { includeWorking: false }),
    },
    // Card facts (type line, mana cost) are reference data about card names, scoped to the
    // workspace, not deck history; the history views only look up the keys of cards in the
    // deck's committed versions.
    catalog: {
      getMany: async (keys) => repos.catalog.getMany(keys),
    },
  };
}
