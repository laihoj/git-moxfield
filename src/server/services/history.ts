/**
 * Read-only views of one deck's committed history: version lists, version details,
 * comparisons, card search and card history, restore exports and tags. Shared by the
 * owner's `DeckServices` and the viewer scope's `SharedDeckServices` (ADR 0007), so both
 * show the same history computed by the same code.
 *
 * Everything here reads through {@link HistoryRepositories}: only the repository methods
 * that read committed history. Observations (the uncommitted working state) are not
 * among them, so nothing in this module can reveal uncommitted Moxfield state. The
 * owner's services add the working state where they show it, as explicit inputs (the
 * card history's {@link WorkingPoint}, the `working` compare side, card search with the
 * working state).
 *
 * Synchronous on purpose: callers wrap calls in `settle`, like the rest of the services.
 */
import 'server-only';

import { allCards, cardZoneIndex, emptySnapshot } from '@/core/canonical';
import { cardKey } from '@/core/card-key';
import { diffSnapshots, renamedKeys } from '@/core/diff';
import { deriveCardHistory, traceCardKeys } from '@/core/history/card-history';
import type { CardHistory, CardVersionPoint, ZoneQuantity } from '@/core/history/types';
import type { CanonicalSnapshot, CardFacts, CardKey } from '@/core/model';
import { primerLineDiff } from '@/core/primer/primer-diff';
import type { RestoreExport, RestoreTarget } from '@/integrations/deck-source';
import {
  DEFAULT_CARD_SEARCH_LIMIT,
  type CardIndexRepository,
  type CatalogRepository,
  type CommitNoteRepository,
  type CommitRecord,
  type CommitRepository,
  type DeckRecord,
  type DeckRepository,
  type SnapshotRepository,
  type VersionTagRepository,
} from '@/server/repositories';
import type { DeckSourceRegistry } from '@/server/sources';

import {
  diffCardKeys,
  toCatalogRecord,
  toCommitNoteDTO,
  toVersionListItemDTO,
  toVersionRefDTO,
  zoneQuantities,
} from './dto';
import { requireRecord, requireSnapshot } from './invariants';
import type { ParsedVersionRef } from './refs';
import type {
  CardSearchResultDTO,
  CompareDTO,
  CompareSideDTO,
  CommittedCompareSideDTO,
  TagCountDTO,
  VersionDetailDTO,
  VersionListItemDTO,
} from './types';

/** Upper bound for card search results. */
export const MAX_CARD_SEARCH_LIMIT = 100;

/** Longest card search query considered; card names are far shorter. */
const MAX_SEARCH_QUERY_LENGTH = 200;

/**
 * The repository methods that read a deck's committed history, and nothing else: no
 * observations, no writes. `Repositories` satisfies it; the viewer scope passes a view
 * confined to the shared deck (`./confined-history`).
 */
export interface HistoryRepositories {
  readonly decks: Pick<DeckRepository, 'getById'>;
  readonly commits: Pick<
    CommitRepository,
    'getById' | 'getBySequence' | 'findByIdPrefix' | 'head' | 'lineage' | 'listForDeck' | 'count'
  >;
  readonly snapshots: Pick<SnapshotRepository, 'get' | 'getMany'>;
  readonly tags: Pick<
    VersionTagRepository,
    'listForCommit' | 'listForCommits' | 'listForDeck' | 'commitsWithTag'
  >;
  readonly notes: Pick<CommitNoteRepository, 'listForCommit'>;
  readonly cardIndex: Pick<CardIndexRepository, 'versionsContainingCard' | 'searchCardsInDeck'>;
  readonly catalog: Pick<CatalogRepository, 'getMany'>;
}

/** A version reference that names committed history (everything but `working`). */
export type CommittedVersionRef = Exclude<ParsedVersionRef, { kind: 'working' }>;

/** A resolved side of a comparison; `snapshot` is `null` for the empty deck. */
export interface ResolvedSide<Side extends CompareSideDTO = CompareSideDTO> {
  side: Side;
  snapshot: CanonicalSnapshot | null;
}

/** The working state as the last point of a card history (owner scope only). */
export interface WorkingPoint {
  fetchedAt: string;
  snapshotHash: string;
  /** Label of the point, e.g. `Current Moxfield deck`. */
  label: string;
}

/** A version detail without the deck summary (which differs between scopes). */
export type VersionHistoryDetail = Omit<VersionDetailDTO, 'deck'>;

/** A comparison without the deck summary and the working-state flag. */
export interface HistoryComparison<Side extends CompareSideDTO> extends Omit<
  CompareDTO,
  'deck' | 'from' | 'to' | 'hasWorking'
> {
  from: Side;
  to: Side;
}

/** Read-only history views over {@link HistoryRepositories}; see the module comment. */
export class DeckHistory {
  constructor(
    private readonly repos: HistoryRepositories,
    private readonly sources: DeckSourceRegistry,
  ) {}

  /** A stored snapshot; its absence means the database is inconsistent. */
  snapshot(hash: string): CanonicalSnapshot {
    return requireRecord(this.repos.snapshots.get(hash), `Snapshot ${hash}`);
  }

  /** The workspace's card facts for `keys`, as a plain record. */
  catalogFor(keys: Iterable<CardKey>): Record<CardKey, CardFacts> {
    return toCatalogRecord(this.repos.catalog.getMany(keys));
  }

  /**
   * List items for `selected` (a subset of `all`, the deck's commits), each with its
   * stats relative to its parent. Snapshots are loaded in one batch.
   */
  versionItems(all: readonly CommitRecord[], selected: readonly CommitRecord[]): VersionListItemDTO[] {
    if (selected.length === 0) return [];
    const byId = new Map(all.map((commit) => [commit.id, commit]));
    const parents = selected.map((commit) =>
      commit.parentId === null ? null : requireRecord(byId.get(commit.parentId), `Commit ${commit.parentId}`),
    );
    const snapshots = this.repos.snapshots.getMany(
      [...selected, ...parents].flatMap((commit) => (commit ? [commit.snapshotHash] : [])),
    );
    const tags = this.repos.tags.listForCommits(selected.map((commit) => commit.id));
    return selected.map((commit, index) => {
      const parent = parents[index] ?? null;
      const snapshot = requireSnapshot(snapshots, commit.snapshotHash);
      const before = parent ? requireSnapshot(snapshots, parent.snapshotHash) : emptySnapshot(snapshot.deck);
      return toVersionListItemDTO({
        commit,
        parent,
        snapshot,
        diff: diffSnapshots(before, snapshot),
        tags: tags.get(commit.id) ?? [],
      });
    });
  }

  /** The deck's versions, newest first; with `tag`, only those carrying it. */
  listVersions(deckId: string, tag = ''): VersionListItemDTO[] {
    const all = this.repos.commits.listForDeck(deckId);
    const wanted = tag.trim();
    if (wanted === '') return this.versionItems(all, all);
    const tagged = new Set(this.repos.tags.commitsWithTag(deckId, wanted).map((commit) => commit.id));
    return this.versionItems(
      all,
      all.filter((commit) => tagged.has(commit.id)),
    );
  }

  /** Version `sequence` of the deck with its diff, primer diff, notes and neighbours, or `null`. */
  versionDetail(deckId: string, sequence: number): VersionHistoryDetail | null {
    const commit = this.repos.commits.getBySequence(deckId, sequence);
    if (!commit) return null;
    const parent =
      commit.parentId === null
        ? null
        : requireRecord(this.repos.commits.getById(commit.parentId), `Commit ${commit.parentId}`);
    const snapshots = this.repos.snapshots.getMany(
      parent ? [commit.snapshotHash, parent.snapshotHash] : [commit.snapshotHash],
    );
    const snapshot = requireSnapshot(snapshots, commit.snapshotHash);
    const parentSnapshot = parent ? requireSnapshot(snapshots, parent.snapshotHash) : null;
    const diff = diffSnapshots(parentSnapshot ?? emptySnapshot(snapshot.deck), snapshot);
    const primerDiff = primerLineDiff(parentSnapshot ? parentSnapshot.primer : '', snapshot.primer);

    const lineage = this.repos.commits.lineage(deckId);
    const position = lineage.findIndex((entry) => entry.id === commit.id);
    const next = position === -1 ? undefined : lineage[position + 1];

    return {
      version: toVersionListItemDTO({
        commit,
        parent,
        snapshot,
        diff,
        tags: this.repos.tags.listForCommit(commit.id),
      }),
      snapshot,
      sourceMetadata: commit.sourceMetadata,
      diff,
      primerDiff,
      notes: this.repos.notes.listForCommit(commit.id).map(toCommitNoteDTO),
      catalog: this.catalogFor([...allCards(snapshot).map((card) => card.key), ...diffCardKeys(diff)]),
      previous: parent ? toVersionRefDTO(parent) : null,
      next: next ? toVersionRefDTO(next) : null,
    };
  }

  /**
   * Resolves a committed version reference within the deck: `head` is the given HEAD;
   * sequences fall back to commit id prefixes where the text is one; prefixes must be
   * unique within the deck. `null` when nothing matches.
   */
  resolveCommitted(
    deckId: string,
    ref: CommittedVersionRef,
    head: CommitRecord | null,
  ): ResolvedSide<CommittedCompareSideDTO> | null {
    let commit: CommitRecord | null;
    switch (ref.kind) {
      case 'empty':
        return { side: { kind: 'empty' }, snapshot: null };
      case 'head':
        commit = head;
        break;
      case 'sequence':
        commit = this.repos.commits.getBySequence(deckId, ref.sequence);
        if (!commit && ref.fallbackPrefix !== null) {
          commit = this.repos.commits.findByIdPrefix(deckId, ref.fallbackPrefix);
        }
        break;
      case 'commit-prefix':
        commit = this.repos.commits.findByIdPrefix(deckId, ref.prefix);
        break;
    }
    if (!commit) return null;
    return {
      side: { kind: 'version', version: toVersionRefDTO(commit) },
      snapshot: this.snapshot(commit.snapshotHash),
    };
  }

  /** The comparison of two resolved sides, with every version of the deck for the pickers. */
  comparison<Side extends CompareSideDTO>(
    deckId: string,
    from: ResolvedSide<Side>,
    to: ResolvedSide<Side>,
  ): HistoryComparison<Side> {
    // The empty side borrows the other side's deck info, so comparing against the empty
    // deck does not report the deck name, format and tags as changes.
    const fromSnapshot = from.snapshot ?? emptySnapshot(to.snapshot?.deck);
    const toSnapshot = to.snapshot ?? emptySnapshot(from.snapshot?.deck);
    const diff = diffSnapshots(fromSnapshot, toSnapshot);
    return {
      from: from.side,
      to: to.side,
      diff,
      primerDiff: primerLineDiff(fromSnapshot.primer, toSnapshot.primer),
      primers: { from: fromSnapshot.primer, to: toSnapshot.primer },
      catalog: this.catalogFor(diffCardKeys(diff)),
      versions: this.repos.commits.listForDeck(deckId).map(toVersionRefDTO),
    };
  }

  /**
   * Cards of the deck's history matching `query`, with their zones in HEAD. With
   * `includeWorking`, cards that are only in the working state match too.
   */
  searchCards(deckId: string, query: string, limit: number, includeWorking: boolean): CardSearchResultDTO[] {
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(MAX_CARD_SEARCH_LIMIT, Math.max(1, Math.floor(limit)))
      : DEFAULT_CARD_SEARCH_LIMIT;
    const hits = this.repos.cardIndex.searchCardsInDeck(
      deckId,
      query.slice(0, MAX_SEARCH_QUERY_LENGTH),
      boundedLimit,
      { includeWorking },
    );
    if (hits.length === 0) return [];

    const head = this.repos.commits.head(deckId);
    const headIndex = head ? cardZoneIndex(this.snapshot(head.snapshotHash)) : null;
    const catalog = this.repos.catalog.getMany(hits.map((hit) => hit.key));
    return hits.map((hit) => ({
      key: hit.key,
      name: hit.name,
      headZones: zoneQuantities(headIndex?.get(hit.key)),
      versionsPresent: hit.versionsPresent,
      lastSeenSequence: hit.lastSeenSequence,
      facts: catalog.get(hit.key) ?? null,
    }));
  }

  /**
   * The history of a card (`card` is a card key or name) over the deck's versions, oldest
   * first, followed by `working` when given. Follows the card across renames the diff
   * reconciles, so either name gives one history. `null` when the card never appears.
   */
  cardHistory(
    deckId: string,
    card: string,
    working: WorkingPoint | null,
  ): { history: CardHistory; facts: CardFacts | null } | null {
    // Keys are fixed points of `cardKey`, so this accepts both keys and names.
    const key = cardKey(card);
    if (key === '') return null;

    const lineage = this.repos.commits.lineage(deckId);
    const points: CardVersionPoint[] = lineage.map((commit) => ({
      commitId: commit.id,
      sequence: commit.sequence,
      at: commit.createdAt,
      message: commit.message,
      zones: [],
    }));
    if (working) {
      points.push({
        commitId: null,
        sequence: null,
        at: working.fetchedAt,
        message: working.label,
        zones: [],
      });
    }
    const hashes = [
      ...lineage.map((commit) => commit.snapshotHash),
      ...(working ? [working.snapshotHash] : []),
    ];
    const snapshots = new Map<number, CanonicalSnapshot>();
    const snapshotAt = (index: number): CanonicalSnapshot => {
      let snapshot = snapshots.get(index);
      if (!snapshot) {
        snapshot = this.snapshot(requireRecord(hashes[index], `Snapshot of point ${index}`));
        snapshots.set(index, snapshot);
      }
      return snapshot;
    };
    // Committed zones come from the snapshot_cards index, one query per key; full
    // snapshots are loaded only where the card may have been renamed.
    const indexedZones = new Map<CardKey, Map<string, ZoneQuantity[]>>();
    let workingIndex: ReturnType<typeof cardZoneIndex> | undefined;
    const zonesAt = (pointKey: CardKey, index: number): ZoneQuantity[] => {
      const commit = lineage[index];
      if (!commit) return zoneQuantities((workingIndex ??= cardZoneIndex(snapshotAt(index))).get(pointKey));
      let byCommit = indexedZones.get(pointKey);
      if (!byCommit) {
        const rows = this.repos.cardIndex.versionsContainingCard(deckId, pointKey);
        byCommit = new Map(rows.map((entry) => [entry.commitId, entry.zones]));
        indexedZones.set(pointKey, byCommit);
      }
      return byCommit.get(commit.id) ?? [];
    };

    const keys = traceCardKeys({
      key,
      length: points.length,
      contains: (pointKey, index) => zonesAt(pointKey, index).length > 0,
      renames: (index) => renamedKeys(snapshotAt(index - 1), snapshotAt(index)),
    });
    points.forEach((point, index) => {
      const pointKey = keys[index] ?? key;
      point.zones = zonesAt(pointKey, index);
      const previousKey = keys[index - 1];
      if (previousKey !== undefined && previousKey !== pointKey) {
        point.renamedFrom = {
          key: previousKey,
          name: cardName(snapshotAt(index - 1), previousKey) ?? previousKey,
        };
      }
    });
    const newest = points.findLastIndex((point) => point.zones.length > 0);
    if (newest === -1) return null;

    const historyKey = keys.at(-1) ?? key;
    const facts = this.repos.catalog.getMany([historyKey]).get(historyKey) ?? null;
    const name = cardName(snapshotAt(newest), keys[newest] ?? key);
    return {
      history: deriveCardHistory({ key: historyKey, name: name ?? facts?.name ?? historyKey, points }),
      facts,
    };
  }

  /**
   * Paste-ready restore text for version `sequence` of the deck, or `null`. `target`: the
   * deck itself (its owner, the default) or a deck of the reader's own (a viewer).
   */
  restoreExport(
    deck: Pick<DeckRecord, 'id' | 'source'>,
    sequence: number,
    target: RestoreTarget = 'source-deck',
  ): { commit: CommitRecord; export: RestoreExport } | null {
    const commit = this.repos.commits.getBySequence(deck.id, sequence);
    if (!commit) return null;
    return {
      commit,
      export: this.sources.require(deck.source).exportForRestore(this.snapshot(commit.snapshotHash), target),
    };
  }

  /** Every tag used in the deck, with the number of versions carrying it, sorted by name. */
  listTags(deckId: string): TagCountDTO[] {
    return this.repos.tags.listForDeck(deckId).map((tag) => ({ name: tag.name, count: tag.count }));
  }
}

/** Display name of a card in a snapshot (first zone that has it), if present. */
function cardName(snapshot: CanonicalSnapshot, key: CardKey): string | undefined {
  return allCards(snapshot).find((card) => card.key === key)?.name;
}
