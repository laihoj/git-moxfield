/**
 * The viewer scope's services (ADR 0007): {@link SharedDeckServices} for the one deck a
 * share link grants. Built by `sharedDeckServices(token)` in `@/server/access` after the
 * token resolved to an active link; never from anything a client sends.
 *
 * Everything is read through {@link confineToDeck}: the repositories bound to the deck's
 * workspace, confined to the deck, without observations. On top of that, every call
 * first checks that the link is still active, so revoking it (or untracking the deck, or
 * disabling its owner) ends access for instances that already exist too.
 */
import 'server-only';

import { commanderNames } from '@/core/canonical';
import { DEFAULT_CARD_SEARCH_LIMIT, type CommitRecord, type DeckRecord } from '@/server/repositories';
import type { DeckSourceRegistry } from '@/server/sources';

import { confineToDeck } from './confined-history';
import type { SharedDeckServices, VersionRef } from './contract';
import { RECENT_VERSION_COUNT } from './deck-services';
import { toVersionRefDTO } from './dto';
import { DeckHistory, type CommittedVersionRef, type HistoryRepositories } from './history';
import { parseVersionRef } from './refs';
import { settle } from './settle';
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
  /** Whether the link still grants access; checked at the start of every call. */
  isActive: () => boolean;
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
  private readonly isActive: () => boolean;

  constructor(deps: SharedDeckServicesDependencies) {
    this.repos = confineToDeck(deps.repos, deps.deckId);
    this.history = new DeckHistory(this.repos, deps.sources);
    this.sources = deps.sources;
    this.deckId = deps.deckId;
    this.includeNotes = deps.includeNotes;
    this.isActive = deps.isActive;
  }

  isAvailable(): Promise<boolean> {
    return settle(() => this.deck() !== null);
  }

  getOverview(): Promise<SharedOverviewDTO | null> {
    return settle(() => {
      const deck = this.deck();
      if (!deck) return null;
      const commits = this.repos.commits.listForDeck(deck.id);
      return {
        ...this.summarize(deck, this.repos.commits.head(deck.id), commits.length),
        recentVersions: this.history.versionItems(commits, commits.slice(0, RECENT_VERSION_COUNT)),
      };
    });
  }

  listVersions(options: { tag?: string } = {}): Promise<VersionListItemDTO[]> {
    return settle(() => (this.deck() ? this.history.listVersions(this.deckId, options.tag) : []));
  }

  getVersion(sequence: number): Promise<SharedVersionDetailDTO | null> {
    return settle(() => {
      const deck = this.deck();
      const detail = deck && isSequence(sequence) ? this.history.versionDetail(deck.id, sequence) : null;
      if (!deck || !detail) return null;
      // The source metadata names the deck on Moxfield: never for viewers (see `summarize`).
      const { sourceMetadata: _sourceMetadata, ...committed } = detail;
      return {
        ...committed,
        deck: this.summarizeAtHead(deck),
        notes: this.includeNotes ? detail.notes : [],
      };
    });
  }

  compare(from: VersionRef, to: VersionRef): Promise<SharedCompareDTO | null> {
    return settle(() => {
      const fromRef = committedRef(from);
      const toRef = committedRef(to);
      const deck = fromRef && toRef ? this.deck() : null;
      if (!deck || !fromRef || !toRef) return null;
      const head = this.repos.commits.head(deck.id);
      const fromSide = this.history.resolveCommitted(deck.id, fromRef, head);
      const toSide = this.history.resolveCommitted(deck.id, toRef, head);
      if (!fromSide || !toSide) return null;
      return {
        ...this.history.comparison(deck.id, fromSide, toSide),
        deck: this.summarize(deck, head, this.repos.commits.count(deck.id)),
        hasWorking: false,
      };
    });
  }

  searchCards(query: string, limit = DEFAULT_CARD_SEARCH_LIMIT): Promise<CardSearchResultDTO[]> {
    return settle(() => (this.deck() ? this.history.searchCards(this.deckId, query, limit, false) : []));
  }

  cardHistory(card: string): Promise<SharedCardHistoryDTO | null> {
    return settle(() => {
      const deck = this.deck();
      const found = deck ? this.history.cardHistory(deck.id, card, null) : null;
      if (!deck || !found) return null;
      return { ...found, deck: this.summarizeAtHead(deck) };
    });
  }

  restoreExport(sequence: number): Promise<SharedRestoreDTO | null> {
    return settle(() => {
      const deck = this.deck();
      // Viewers restore into a deck of their own: they never get the owner's (see `summarize`).
      const restore =
        deck && isSequence(sequence) ? this.history.restoreExport(deck, sequence, 'own-deck') : null;
      if (!deck || !restore) return null;
      return {
        deck: this.summarizeAtHead(deck),
        version: toVersionRefDTO(restore.commit),
        export: restore.export,
      };
    });
  }

  listTags(): Promise<TagCountDTO[]> {
    return settle(() => (this.deck() ? this.history.listTags(this.deckId) : []));
  }

  primerToMarkdown(source: string, primer: string): string {
    return this.sources.get(source)?.primerToMarkdown(primer) ?? primer;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** The shared deck while the link grants access to it; `null` otherwise. */
  private deck(): DeckRecord | null {
    return this.isActive() ? this.repos.decks.getById(this.deckId) : null;
  }

  private summarizeAtHead(deck: DeckRecord): SharedDeckDTO {
    return this.summarize(deck, this.repos.commits.head(deck.id), this.repos.commits.count(deck.id));
  }

  /**
   * The deck as viewers see it: name, format and commanders of the latest version
   * (`head`). The deck row's cached name and format are never used: they follow the
   * latest Moxfield state, which may be uncommitted. Nor is where the deck lives on
   * Moxfield (its public id, its URL): that URL opens the live deck, uncommitted changes
   * included (for an unlisted deck it is the only key to it), and a viewer would keep it
   * after the link is revoked.
   */
  private summarize(deck: DeckRecord, head: CommitRecord | null, versionCount: number): SharedDeckDTO {
    const snapshot = head ? this.history.snapshot(head.snapshotHash) : null;
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

/** Whether `value` can be a version's sequence (a positive safe integer). */
function isSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}
