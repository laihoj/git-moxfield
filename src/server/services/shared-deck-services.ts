/**
 * The viewer scope's services (ADR 0007): {@link SharedDeckServices} for the one deck a
 * share link grants. Built by `sharedDeckServices(token)` in `@/server/access` after the
 * token resolved to an active link; never from anything a client sends.
 *
 * Everything is read through {@link confineToDeck}: the repositories bound to the deck's
 * workspace, confined to the deck, without observations. On top of that, every call
 * checks that the link is still active, so revoking it (or untracking the deck, or
 * disabling its owner) ends access for instances that already exist too. (The check runs
 * alongside the call's first read; nothing is returned unless the link is active.)
 */
import 'server-only';

import { commanderNames } from '@/core/canonical';
import { isSequence } from '@/core/sequence';
import { DEFAULT_CARD_SEARCH_LIMIT, type CommitRecord, type DeckRecord } from '@/server/repositories';
import type { DeckSourceRegistry } from '@/server/sources';

import { confineToDeck } from './confined-history';
import type { SharedDeckServices, VersionRef } from './contract';
import { RECENT_VERSION_COUNT } from './deck-services';
import { toVersionRefDTO } from './dto';
import { DeckHistory, type CommittedVersionRef, type HistoryRepositories } from './history';
import { unlessDeckVanished } from './invariants';
import { parseVersionRef } from './refs';
import type {
  CardSearchResultDTO,
  SharedCardHistoryDTO,
  SharedCompareDTO,
  SharedDeckDTO,
  SharedOverviewDTO,
  SharedRestoreDTO,
  SharedVersionDetailDTO,
  TagCountDTO,
  VersionListItemDTO,
} from './types';

export interface SharedDeckServicesDependencies {
  /** Repositories bound to the shared deck's workspace (confined to the deck here). */
  repos: HistoryRepositories;
  sources: DeckSourceRegistry;
  /** The deck the link grants. */
  deckId: string;
  /** Whether version notes are shown. */
  includeNotes: boolean;
  /** Whether the link still grants access; checked on every call. */
  isActive: () => Promise<boolean>;
}

/** Creates the viewer services of one shared deck. */
export function createSharedDeckServices(deps: SharedDeckServicesDependencies): SharedDeckServices {
  return new DefaultSharedDeckServices(deps);
}

class DefaultSharedDeckServices implements SharedDeckServices {
  private readonly repos: HistoryRepositories;
  private readonly history: DeckHistory;
  private readonly sources: DeckSourceRegistry;
  private readonly deckId: string;
  private readonly includeNotes: boolean;
  private readonly isActive: () => Promise<boolean>;

  constructor(deps: SharedDeckServicesDependencies) {
    this.repos = confineToDeck(deps.repos, deps.deckId);
    this.history = new DeckHistory(this.repos, deps.sources);
    this.sources = deps.sources;
    this.deckId = deps.deckId;
    this.includeNotes = deps.includeNotes;
    this.isActive = deps.isActive;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.deck()) !== null;
  }

  getOverview(): Promise<SharedOverviewDTO | null> {
    return this.whileShared(null, async () => {
      const deck = await this.deck();
      if (!deck) return null;
      const [commits, head] = await Promise.all([
        this.repos.commits.listForDeck(deck.id),
        this.repos.commits.head(deck.id),
      ]);
      const [summary, recentVersions] = await Promise.all([
        this.summarize(deck, head, commits.length),
        this.history.versionItems(commits, commits.slice(0, RECENT_VERSION_COUNT)),
      ]);
      return { ...summary, recentVersions };
    });
  }

  listVersions(options: { tag?: string } = {}): Promise<VersionListItemDTO[]> {
    return this.whileShared([], async () =>
      (await this.deck()) ? this.history.listVersions(this.deckId, options.tag) : [],
    );
  }

  getVersion(sequence: number): Promise<SharedVersionDetailDTO | null> {
    return this.whileShared(null, async () => {
      const deck = await this.deck();
      if (!deck || !isSequence(sequence)) return null;
      const [detail, summary] = await Promise.all([
        this.history.versionDetail(deck, sequence),
        this.summarizeAtHead(deck),
      ]);
      if (!detail) return null;
      // The source metadata names the deck on Moxfield: never for viewers (see `summarize`).
      const { sourceMetadata: _sourceMetadata, ...committed } = detail;
      return { ...committed, deck: summary, notes: this.includeNotes ? detail.notes : [] };
    });
  }

  compare(from: VersionRef, to: VersionRef): Promise<SharedCompareDTO | null> {
    return this.whileShared(null, async () => {
      const fromRef = committedRef(from);
      const toRef = committedRef(to);
      const deck = fromRef && toRef ? await this.deck() : null;
      if (!deck || !fromRef || !toRef) return null;
      const [head, versionCount] = await Promise.all([
        this.repos.commits.head(deck.id),
        this.repos.commits.count(deck.id),
      ]);
      const [fromSide, toSide] = await Promise.all([
        this.history.resolveCommitted(deck.id, fromRef, head),
        this.history.resolveCommitted(deck.id, toRef, head),
      ]);
      if (!fromSide || !toSide) return null;
      const [comparison, summary] = await Promise.all([
        this.history.comparison(deck.id, fromSide, toSide),
        this.summarize(deck, head, versionCount),
      ]);
      return { ...comparison, deck: summary, hasWorking: false };
    });
  }

  searchCards(query: string, limit = DEFAULT_CARD_SEARCH_LIMIT): Promise<CardSearchResultDTO[]> {
    return this.whileShared([], async () =>
      (await this.deck()) ? this.history.searchCards(this.deckId, query, limit, false) : [],
    );
  }

  cardHistory(card: string): Promise<SharedCardHistoryDTO | null> {
    return this.whileShared(null, async () => {
      const deck = await this.deck();
      if (!deck) return null;
      const [found, summary] = await Promise.all([
        this.history.cardHistory(deck.id, card, null),
        this.summarizeAtHead(deck),
      ]);
      if (!found) return null;
      return { ...found, deck: summary };
    });
  }

  restoreExport(sequence: number): Promise<SharedRestoreDTO | null> {
    return this.whileShared(null, async () => {
      const deck = await this.deck();
      if (!deck || !isSequence(sequence)) return null;
      // Viewers restore into a deck of their own: they never get the owner's (see `summarize`).
      const [restore, summary] = await Promise.all([
        this.history.restoreExport(deck, sequence, 'own-deck'),
        this.summarizeAtHead(deck),
      ]);
      if (!restore) return null;
      return { deck: summary, version: toVersionRefDTO(restore.commit), export: restore.export };
    });
  }

  async listTags(): Promise<TagCountDTO[]> {
    return (await this.deck()) ? this.history.listTags(this.deckId) : [];
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Runs `read`; when the deck is untracked (or the link revoked) while it runs, answers
   * `whenGone`, as for a link that grants nothing, instead of failing on what went with the
   * deck (see `unlessDeckVanished`).
   */
  private whileShared<T>(whenGone: T, read: () => Promise<T>): Promise<T> {
    return unlessDeckVanished(read, async () => (await this.deck()) !== null, whenGone);
  }

  /**
   * The shared deck while the link grants access to it; `null` otherwise. The link check
   * and the deck lookup run together (one round trip); the deck is only returned when the
   * link is active.
   */
  private async deck(): Promise<DeckRecord | null> {
    const [active, deck] = await Promise.all([this.isActive(), this.repos.decks.getById(this.deckId)]);
    return active ? deck : null;
  }

  private async summarizeAtHead(deck: DeckRecord): Promise<SharedDeckDTO> {
    const [head, versionCount] = await Promise.all([
      this.repos.commits.head(deck.id),
      this.repos.commits.count(deck.id),
    ]);
    return this.summarize(deck, head, versionCount);
  }

  /**
   * The deck as viewers see it: name, format and commanders of the latest version
   * (`head`). The deck row's cached name and format are never used: they follow the
   * latest Moxfield state, which may be uncommitted. Nor is where the deck lives on
   * Moxfield (its public id, its URL): that URL opens the live deck, uncommitted changes
   * included (for an unlisted deck it is the only key to it), and a viewer would keep it
   * after the link is revoked.
   */
  private async summarize(
    deck: DeckRecord,
    head: CommitRecord | null,
    versionCount: number,
  ): Promise<SharedDeckDTO> {
    const snapshot = head ? await this.history.snapshot(head.snapshotHash) : null;
    return {
      id: deck.id,
      source: deck.source,
      name: snapshot?.deck.name ?? '',
      format: snapshot?.deck.format ?? '',
      commanders: snapshot ? commanderNames(snapshot) : [],
      head: head ? toVersionRefDTO(head) : null,
      versionCount,
    };
  }
}

/** A parsed reference to committed history; `null` for `working` and anything unparseable. */
function committedRef(ref: VersionRef): CommittedVersionRef | null {
  const parsed = parseVersionRef(ref);
  return parsed === null || parsed.kind === 'working' ? null : parsed;
}
