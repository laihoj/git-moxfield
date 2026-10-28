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
 * Every view is asynchronous. Remotely each repository call is a round trip, so reads
 * that do not depend on each other are started together.
 *
 * The deck view (`@/core/deck-view`) the instance is built for shapes what it returns:
 * in the cEDH view, snapshots are projected to the played zones before diffing and
 * listing, and a card's zones leave out the hidden ones. Restore exports never are: they
 * put the whole deck back.
 */
import 'server-only';

import { allCards, cardName, cardZoneIndex, emptySnapshot } from '@/core/canonical';
import { cardKey } from '@/core/card-key';
import { splitCommitMessage } from '@/core/commit-message';
import { viewSnapshot, viewSnapshotPair, viewZoneQuantities, type DeckView } from '@/core/deck-view';
import { diffSnapshots, hiddenChangeCount, renamedKeys } from '@/core/diff';
import { deriveCardHistory, traceCardPoints } from '@/core/history/card-history';
import type { CardHistory, VersionMeta, ZoneQuantity } from '@/core/history/types';
import type { DeckDiff } from '@/core/diff/types';
import type { CanonicalSnapshot, CardFacts, CardKey } from '@/core/model';
import { primerLineDiff } from '@/core/primer/primer-diff';
import { MAX_CARD_QUERY_LENGTH } from '@/core/text-limits';
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
  /** The working state's snapshot (the caller has it loaded already). */
  snapshot: CanonicalSnapshot;
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
    /** The deck view the read models are computed for. */
    private readonly view: DeckView = 'mtg',
  ) {}

  /** `snapshot` as the view sees it (the snapshot itself in the MTG view). */
  private shown(snapshot: CanonicalSnapshot): CanonicalSnapshot {
    return viewSnapshot(snapshot, this.view);
  }

  /**
   * The diff `before` → `after` as the view sees it, and how many differences of the full
   * diff it leaves out (`0` in the MTG view, where both diffs are one).
   */
  private viewDiff(before: CanonicalSnapshot, after: CanonicalSnapshot): { diff: DeckDiff; hidden: number } {
    const full = diffSnapshots(before, after);
    if (this.view === 'mtg') return { diff: full, hidden: 0 };
    const diff = diffSnapshots(...viewSnapshotPair(before, after, this.view));
    return { diff, hidden: hiddenChangeCount(full, diff) };
  }

  /** A primer as markdown, by the deck's source (as is for an unknown source); `null` without one. */
  primerMarkdown(source: string, primer: string | null): string | null {
    if (primer === null || primer === '') return null;
    return this.sources.get(source)?.primerToMarkdown(primer) ?? primer;
  }

  /** A stored snapshot; its absence means the database is inconsistent. */
  async snapshot(hash: string): Promise<CanonicalSnapshot> {
    return requireRecord(await this.repos.snapshots.get(hash), `Snapshot ${hash}`);
  }

  /** The workspace's card facts for `keys`, as a plain record. */
  async catalogFor(keys: Iterable<CardKey>): Promise<Record<CardKey, CardFacts>> {
    return toCatalogRecord(await this.repos.catalog.getMany(keys));
  }

  /**
   * List items for `selected` (a subset of `all`, the deck's commits), each with its
   * stats relative to its parent. Snapshots are loaded in one batch.
   */
  async versionItems(
    all: readonly CommitRecord[],
    selected: readonly CommitRecord[],
  ): Promise<VersionListItemDTO[]> {
    if (selected.length === 0) return [];
    const byId = new Map(all.map((commit) => [commit.id, commit]));
    const parents = selected.map((commit) =>
      commit.parentId === null ? null : requireRecord(byId.get(commit.parentId), `Commit ${commit.parentId}`),
    );
    const [snapshots, tags] = await Promise.all([
      this.repos.snapshots.getMany(
        [...selected, ...parents].flatMap((commit) => (commit ? [commit.snapshotHash] : [])),
      ),
      this.repos.tags.listForCommits(selected.map((commit) => commit.id)),
    ]);
    return selected.map((commit, index) => {
      const parent = parents[index] ?? null;
      const stored = requireSnapshot(snapshots, commit.snapshotHash);
      const [before, snapshot] = viewSnapshotPair(
        parent ? requireSnapshot(snapshots, parent.snapshotHash) : emptySnapshot(stored.deck),
        stored,
        this.view,
      );
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
  async listVersions(deckId: string, tag = ''): Promise<VersionListItemDTO[]> {
    const wanted = tag.trim();
    const [all, withTag] = await Promise.all([
      this.repos.commits.listForDeck(deckId),
      wanted === '' ? null : this.repos.tags.commitsWithTag(deckId, wanted),
    ]);
    if (withTag === null) return this.versionItems(all, all);
    const tagged = new Set(withTag.map((commit) => commit.id));
    return this.versionItems(
      all,
      all.filter((commit) => tagged.has(commit.id)),
    );
  }

  /** Version `sequence` of the deck with its diff, primer diff, notes and neighbours, or `null`. */
  async versionDetail(
    deck: Pick<DeckRecord, 'id' | 'source'>,
    sequence: number,
  ): Promise<VersionHistoryDetail | null> {
    const deckId = deck.id;
    const commit = await this.repos.commits.getBySequence(deckId, sequence);
    if (!commit) return null;
    const [parent, lineage, tags, notes] = await Promise.all([
      commit.parentId === null
        ? null
        : this.repos.commits
            .getById(commit.parentId)
            .then((found) => requireRecord(found, `Commit ${commit.parentId}`)),
      this.repos.commits.lineage(deckId),
      this.repos.tags.listForCommit(commit.id),
      this.repos.notes.listForCommit(commit.id),
    ]);
    const snapshots = await this.repos.snapshots.getMany(
      parent ? [commit.snapshotHash, parent.snapshotHash] : [commit.snapshotHash],
    );
    const stored = requireSnapshot(snapshots, commit.snapshotHash);
    const parentSnapshot = parent ? requireSnapshot(snapshots, parent.snapshotHash) : null;
    const { diff, hidden } = this.viewDiff(parentSnapshot ?? emptySnapshot(stored.deck), stored);
    const snapshot = this.shown(stored);
    const primerDiff = primerLineDiff(parentSnapshot ? parentSnapshot.primer : '', snapshot.primer);

    const position = lineage.findIndex((entry) => entry.id === commit.id);
    const next = position === -1 ? undefined : lineage[position + 1];

    return {
      view: this.view,
      version: toVersionListItemDTO({ commit, parent, snapshot, diff, tags }),
      snapshot,
      primerMarkdown: this.primerMarkdown(deck.source, snapshot.primer),
      sourceMetadata: commit.sourceMetadata,
      diff,
      hiddenChangeCount: hidden,
      primerDiff,
      notes: notes.map(toCommitNoteDTO),
      catalog: await this.catalogFor([...allCards(snapshot).map((card) => card.key), ...diffCardKeys(diff)]),
      previous: parent ? toVersionRefDTO(parent) : null,
      next: next ? toVersionRefDTO(next) : null,
    };
  }

  /**
   * Resolves a committed version reference within the deck: `head` is the given HEAD;
   * sequences fall back to commit id prefixes where the text is one; prefixes must be
   * unique within the deck. `null` when nothing matches.
   */
  async resolveCommitted(
    deckId: string,
    ref: CommittedVersionRef,
    head: CommitRecord | null,
  ): Promise<ResolvedSide<CommittedCompareSideDTO> | null> {
    let commit: CommitRecord | null;
    switch (ref.kind) {
      case 'empty':
        return { side: { kind: 'empty' }, snapshot: null };
      case 'head':
        commit = head;
        break;
      case 'sequence':
        commit = await this.repos.commits.getBySequence(deckId, ref.sequence);
        if (!commit && ref.fallbackPrefix !== null) {
          commit = await this.repos.commits.findByIdPrefix(deckId, ref.fallbackPrefix);
        }
        break;
      case 'commit-prefix':
        commit = await this.repos.commits.findByIdPrefix(deckId, ref.prefix);
        break;
    }
    if (!commit) return null;
    return {
      side: { kind: 'version', version: toVersionRefDTO(commit) },
      snapshot: await this.snapshot(commit.snapshotHash),
    };
  }

  /** The comparison of two resolved sides, with every version of the deck for the pickers. */
  async comparison<Side extends CompareSideDTO>(
    deckId: string,
    from: ResolvedSide<Side>,
    to: ResolvedSide<Side>,
  ): Promise<HistoryComparison<Side>> {
    // The empty side borrows the other side's deck info, so comparing against the empty
    // deck does not report the deck name, format and tags as changes.
    const fromSnapshot = from.snapshot ?? emptySnapshot(to.snapshot?.deck);
    const toSnapshot = to.snapshot ?? emptySnapshot(from.snapshot?.deck);
    const { diff, hidden } = this.viewDiff(fromSnapshot, toSnapshot);
    const [catalog, versions] = await Promise.all([
      this.catalogFor(diffCardKeys(diff)),
      this.repos.commits.listForDeck(deckId),
    ]);
    return {
      view: this.view,
      from: from.side,
      to: to.side,
      diff,
      hiddenChangeCount: hidden,
      primerDiff: primerLineDiff(fromSnapshot.primer, toSnapshot.primer),
      primers: { from: fromSnapshot.primer, to: toSnapshot.primer },
      catalog,
      versions: versions.map(toVersionRefDTO),
    };
  }

  /**
   * Cards of the deck's history matching `query`, with their zones in HEAD. With
   * `includeWorking`, cards that are only in the working state match too.
   */
  async searchCards(
    deckId: string,
    query: string,
    limit: number,
    includeWorking: boolean,
  ): Promise<CardSearchResultDTO[]> {
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(MAX_CARD_SEARCH_LIMIT, Math.max(1, Math.floor(limit)))
      : DEFAULT_CARD_SEARCH_LIMIT;
    const hits = await this.repos.cardIndex.searchCardsInDeck(
      deckId,
      query.slice(0, MAX_CARD_QUERY_LENGTH),
      boundedLimit,
      { includeWorking },
    );
    if (hits.length === 0) return [];

    const [head, catalog] = await Promise.all([
      this.repos.commits.head(deckId),
      this.repos.catalog.getMany(hits.map((hit) => hit.key)),
    ]);
    const headIndex = head ? cardZoneIndex(this.shown(await this.snapshot(head.snapshotHash))) : null;
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
   *
   * Committed zones come from the `snapshot_cards` index (one query per key the card had);
   * full snapshots are loaded only where the card may have been renamed (see
   * {@link CardHistoryInputs}).
   */
  async cardHistory(
    deckId: string,
    card: string,
    working: WorkingPoint | null,
  ): Promise<{ history: CardHistory; facts: CardFacts | null } | null> {
    // Keys are fixed points of `cardKey`, so this accepts both keys and names.
    const key = cardKey(card);
    if (key === '') return null;

    const lineage = await this.repos.commits.lineage(deckId);
    const inputs = new CardHistoryInputs(
      this.repos,
      deckId,
      lineage,
      working ? this.shown(working.snapshot) : null,
      this.view,
    );
    const [, keyFacts] = await Promise.all([inputs.prefetch(key), this.repos.catalog.getMany([key])]);

    const versions: VersionMeta[] = lineage.map((commit) => ({
      commitId: commit.id,
      sequence: commit.sequence,
      at: commit.createdAt,
      message: splitCommitMessage(commit.message).subject,
    }));
    if (working) {
      versions.push({ commitId: null, sequence: null, at: working.fetchedAt, message: working.label });
    }
    const traced = await inputs.run(() => {
      const { points, keys } = traceCardPoints(key, {
        points: versions,
        zonesAt: (pointKey, index) => inputs.zonesAt(pointKey, index),
        renames: (index) => {
          const [before, after] = inputs.snapshotPair(index - 1, index);
          return renamedKeys(before, after);
        },
        nameAt: (pointKey, index) => cardName(inputs.snapshotAt(index), pointKey),
      });
      const newest = points.findLastIndex((point) => point.zones.length > 0);
      if (newest === -1) return null;
      return {
        points,
        historyKey: keys.at(-1) ?? key,
        name: cardName(inputs.snapshotAt(newest), keys[newest] ?? key),
      };
    });
    if (traced === null) return null;

    const { points, historyKey, name } = traced;
    const catalog = historyKey === key ? keyFacts : await this.repos.catalog.getMany([historyKey]);
    const facts = catalog.get(historyKey) ?? null;
    return {
      history: deriveCardHistory({ key: historyKey, name: name ?? facts?.name ?? historyKey, points }),
      facts,
    };
  }

  /**
   * Paste-ready restore text for version `sequence` of the deck, or `null`. `target`: the
   * deck itself (its owner, the default) or a deck of the reader's own (a viewer).
   */
  async restoreExport(
    deck: Pick<DeckRecord, 'id' | 'source'>,
    sequence: number,
    target: RestoreTarget = 'source-deck',
  ): Promise<{ commit: CommitRecord; export: RestoreExport } | null> {
    const commit = await this.repos.commits.getBySequence(deck.id, sequence);
    if (!commit) return null;
    const snapshot = await this.snapshot(commit.snapshotHash);
    return { commit, export: this.sources.require(deck.source).exportForRestore(snapshot, target) };
  }

  /** Every tag used in the deck, with the number of versions carrying it, sorted by name. */
  async listTags(deckId: string): Promise<TagCountDTO[]> {
    return (await this.repos.tags.listForDeck(deckId)).map(({ name, count, lastSequence }) => ({
      name,
      count,
      lastSequence,
    }));
  }
}

/** Thrown by {@link CardHistoryInputs} when a run needs data that is not loaded yet. */
class MissingCardHistoryInput extends Error {
  override readonly name = 'MissingCardHistoryInput';
}

/**
 * The inputs of one card history, loaded on demand: per card key, the versions of the deck
 * that contain it (from the `snapshot_cards` index), and per point, its full snapshot.
 *
 * The tracing in `@/core/history` is synchronous and discovers what it needs as it goes:
 * which keys depends on the renames it finds, and it compares full snapshots only where a
 * tracked key appears or disappears. So it runs against this cache ({@link run}): a miss
 * records what is missing and aborts the run, which then loads everything missing (one
 * round of parallel queries) and runs again. A run is a pure computation over the cache,
 * so running again is cheap and gives exactly the result of one uninterrupted run with
 * every input at hand; every round loads at least one more input, so it ends.
 * {@link prefetch} loads up front what the run for a card that was never renamed needs,
 * so that the common case takes no extra round.
 */
class CardHistoryInputs {
  /** Per key: the zones of the card in each version that contains it, by commit id. */
  readonly #occurrences = new Map<CardKey, ReadonlyMap<string, ZoneQuantity[]>>();
  /** Per point index. */
  readonly #snapshots = new Map<number, CanonicalSnapshot>();
  readonly #missingKeys = new Set<CardKey>();
  readonly #missingPoints = new Set<number>();
  #workingIndex: ReturnType<typeof cardZoneIndex> | undefined;

  /**
   * @param lineage the deck's versions, oldest first: points `0 … lineage.length - 1`.
   * @param working the working state's snapshot (as the view sees it): the last point, when given.
   * @param view the deck view: a card's zones leave out the ones it hides.
   */
  constructor(
    private readonly repos: HistoryRepositories,
    private readonly deckId: string,
    private readonly lineage: readonly CommitRecord[],
    working: CanonicalSnapshot | null,
    private readonly view: DeckView,
  ) {
    if (working !== null) this.#snapshots.set(lineage.length, working);
  }

  /** Number of points: the versions, plus the working state when given. */
  get length(): number {
    return this.lineage.length + (this.#snapshots.has(this.lineage.length) ? 1 : 0);
  }

  /** The card `key`'s zones at point `index` that the view shows (empty when the point does not contain it there). */
  zonesAt(key: CardKey, index: number): ZoneQuantity[] {
    const commit = this.lineage[index];
    if (!commit)
      return zoneQuantities((this.#workingIndex ??= cardZoneIndex(this.snapshotAt(index))).get(key));
    const byCommit = this.#occurrences.get(key);
    if (byCommit === undefined) {
      this.#missingKeys.add(key);
      throw new MissingCardHistoryInput(`The versions containing ${key} are not loaded`);
    }
    return viewZoneQuantities(this.view, byCommit.get(commit.id) ?? []);
  }

  /** The full snapshot at point `index`. */
  snapshotAt(index: number): CanonicalSnapshot {
    this.#requireSnapshots(index);
    return this.#snapshot(index);
  }

  /** The full snapshots at points `a` and `b`, asking for both at once when they are missing. */
  snapshotPair(a: number, b: number): [CanonicalSnapshot, CanonicalSnapshot] {
    this.#requireSnapshots(a, b);
    return [this.#snapshot(a), this.#snapshot(b)];
  }

  /**
   * Loads what tracing `key` needs when the card was never renamed: its versions, and the
   * snapshots of the points where it is looked up in full (where it entered the deck, up
   * to its newest point; the point after that; its newest point, for its name). Follows
   * how `traceCardKeys` walks; a mismatch would only cost another round in {@link run}.
   */
  async prefetch(key: CardKey): Promise<void> {
    await this.#load([key], []);
    const present = Array.from({ length: this.length }, (_, index) => this.zonesAt(key, index).length > 0);
    const anchor = present.lastIndexOf(true);
    if (anchor === -1) return;
    const points = new Set([anchor, anchor + 1]);
    for (let index = 1; index <= anchor; index++) {
      if (present[index] === true && present[index - 1] === false) points.add(index - 1).add(index);
    }
    await this.#load([], points);
  }

  /** Runs `compute` (pure and synchronous) until it no longer misses an input; returns its result. */
  async run<T>(compute: () => T): Promise<T> {
    for (;;) {
      try {
        return compute();
      } catch (error) {
        if (!(error instanceof MissingCardHistoryInput)) throw error;
      }
      const keys = [...this.#missingKeys];
      const points = [...this.#missingPoints];
      this.#missingKeys.clear();
      this.#missingPoints.clear();
      if ((await this.#load(keys, points)) === 0) {
        throw new Error('A card history asked for inputs that do not exist');
      }
    }
  }

  #requireSnapshots(...indices: number[]): void {
    const missing = indices.filter((index) => !this.#snapshots.has(index));
    if (missing.length === 0) return;
    for (const index of missing) this.#missingPoints.add(index);
    throw new MissingCardHistoryInput(`The snapshots of points ${missing.join(', ')} are not loaded`);
  }

  #snapshot(index: number): CanonicalSnapshot {
    return requireRecord(this.#snapshots.get(index), `Snapshot of point ${index}`);
  }

  /**
   * Loads the versions containing each of `keys` and the snapshots of the versions among
   * `points` that are not loaded yet, in parallel. @returns how many inputs it loaded.
   */
  async #load(keys: Iterable<CardKey>, points: Iterable<number>): Promise<number> {
    const wantedKeys = [...new Set(keys)].filter((key) => !this.#occurrences.has(key));
    const wantedCommits = [...new Set(points)].flatMap((index) => {
      const commit = this.lineage[index];
      return commit === undefined || this.#snapshots.has(index) ? [] : [{ index, commit }];
    });
    if (wantedKeys.length === 0 && wantedCommits.length === 0) return 0;
    const [rows, snapshots] = await Promise.all([
      Promise.all(wantedKeys.map((key) => this.repos.cardIndex.versionsContainingCard(this.deckId, key))),
      wantedCommits.length === 0
        ? new Map<string, CanonicalSnapshot>()
        : this.repos.snapshots.getMany(wantedCommits.map(({ commit }) => commit.snapshotHash)),
    ]);
    wantedKeys.forEach((key, position) => {
      const versions = rows[position] ?? [];
      this.#occurrences.set(key, new Map(versions.map((entry) => [entry.commitId, entry.zones])));
    });
    for (const { index, commit } of wantedCommits) {
      this.#snapshots.set(index, requireSnapshot(snapshots, commit.snapshotHash));
    }
    return wantedKeys.length + wantedCommits.length;
  }
}
