/**
 * The application service layer: implements {@link DeckServices} on top of the
 * repositories, the deck sources and the pure core (diff, history, primer diff).
 *
 * Concurrency: every operation that reads and then writes a deck's working state or
 * history (refresh, capture ingestion, commit, untrack) runs under a per-deck lock, so
 * they never interleave for the same deck. Multi-step writes run in one repository
 * transaction; a commit additionally re-checks HEAD inside its transaction
 * (compare-and-set), which also protects against other processes and function instances.
 *
 * Transactions follow the rules of `runInTransaction` (`src/server/db/transaction.ts`):
 * the deck lock is always taken first and never inside a transaction; network requests to
 * the deck source (fetches) happen outside transactions; a transaction callback only reads
 * and writes through the repositories it receives and may run more than once, so log lines
 * and other effects come after it has committed.
 *
 * Remotely every query is a round trip, so independent reads are started together.
 *
 * Every returned value is plain JSON-serializable data (it crosses the React Server
 * Components boundary). Failures that the user can act on are returned as outcome
 * values; programming errors and unknown decks surface as exceptions
 * ({@link ServiceError} for the latter).
 */
import 'server-only';

import { commanderNames, emptySnapshot, zoneCards } from '@/core/canonical';
import { diffSnapshots, suggestCommitMessage } from '@/core/diff';
import type { DeckDiff } from '@/core/diff/types';
import { commitId } from '@/core/hash';
import type { CanonicalSnapshot, NormalizedDeck } from '@/core/model';
import {
  DeckSourceError,
  isDeckSourceError,
  type DeckRef,
  type DeckSource,
  type IngestMethod,
  type RawSourcePayload,
  type ServerFetchStatus,
} from '@/integrations/deck-source';
import { MOXFIELD_SOURCE_ID } from '@/integrations/moxfield/constants';
import type { AppConfig } from '@/server/config';
import type { Logger } from '@/server/logger';
import {
  DEFAULT_CARD_SEARCH_LIMIT,
  isRepositoryError,
  normalizeVersionTag,
  type BranchRecord,
  type CommitRecord,
  type DeckRecord,
  type FetchErrorRecord,
  type ObservationRecord,
  type Repositories,
} from '@/server/repositories';
import type { DeckSourceRegistry } from '@/server/sources';

import { mapConcurrently } from './concurrency';
import type { DeckServices, SetupInfoDTO, TagOutcome, TrackDeckOutcome, VersionRef } from './contract';
import {
  deckStatus,
  diffCardKeys,
  toCommitNoteDTO,
  toFetchErrorDTO,
  toObservationDTO,
  toVersionRefDTO,
} from './dto';
import { ServiceError } from './errors';
import { DeckHistory, type ResolvedSide } from './history';
import { requireRecord, requireSnapshot } from './invariants';
import type { KeyedMutex } from './mutex';
import { parseVersionRef } from './refs';
import { setupInfo } from './setup-info';
import type {
  CaptureOutcome,
  CardHistoryDTO,
  CardSearchResultDTO,
  CommitNoteDTO,
  CommitOutcome,
  CompareDTO,
  DeckOverviewDTO,
  DeckSummaryDTO,
  FetchErrorDTO,
  FetchOutcome,
  RestoreDTO,
  TagCountDTO,
  VersionDetailDTO,
  VersionListItemDTO,
} from './types';

/** Maximum commit message length in characters (Unicode code points). */
export const MAX_COMMIT_MESSAGE_LENGTH = 2000;

/** Maximum free-text note length in characters (Unicode code points). */
export const MAX_NOTE_LENGTH = 20_000;

/** Note kind of the free-text note managed by {@link DeckServices.setNote}; data is `{ text }`. */
export const FREE_TEXT_NOTE_KIND = 'note';

/** Number of versions in {@link DeckOverviewDTO.recentVersions}. */
export const RECENT_VERSION_COUNT = 8;

/** Suggested message for a deck's first version. */
const INITIAL_VERSION_MESSAGE = 'Initial version';

/**
 * The source that browser captures and manual pastes come from. The capture protocol
 * (bookmarklet envelope, pasted API JSON) is Moxfield's.
 */
const CAPTURE_SOURCE_ID = MOXFIELD_SOURCE_ID;

export interface DeckServicesDependencies {
  repos: Repositories;
  sources: DeckSourceRegistry;
  config: AppConfig;
  /** Clock for every timestamp the services record or compare against. */
  now: () => Date;
  logger: Logger;
  /** Per-deck locks; one instance per process. */
  locks: KeyedMutex;
}

/** Why the server fetched a deck: an explicit or automatic refresh, or a commit. */
type FetchReason = 'manual' | 'auto' | 'commit';

type CommitFailureReason = Extract<CommitOutcome, { ok: false }>['reason'];

interface Ingested {
  observation: ObservationRecord;
  changed: boolean;
}

type FetchResult = ({ ok: true } & Ingested) | { ok: false; error: FetchErrorDTO };

/** HEAD, working state and their diff for one deck. */
interface DeckState {
  deck: DeckRecord;
  head: CommitRecord | null;
  headSnapshot: CanonicalSnapshot | null;
  working: ObservationRecord | null;
  workingSnapshot: CanonicalSnapshot | null;
  /** HEAD (or the empty deck) → working state; `null` without a working state. */
  diff: DeckDiff | null;
  /** Number of versions. */
  versionCount: number;
}

/** Creates the service layer over already-constructed dependencies. */
export function createDeckServices(deps: DeckServicesDependencies): DeckServices {
  return new DefaultDeckServices(deps);
}

class DefaultDeckServices implements DeckServices {
  private readonly repos: Repositories;
  private readonly sources: DeckSourceRegistry;
  private readonly config: AppConfig;
  private readonly now: () => Date;
  private readonly logger: Logger;
  private readonly locks: KeyedMutex;
  /** The committed-history views, shared with the viewer scope. */
  private readonly history: DeckHistory;

  constructor(deps: DeckServicesDependencies) {
    this.repos = deps.repos;
    this.sources = deps.sources;
    this.config = deps.config;
    this.now = deps.now;
    this.logger = deps.logger;
    this.locks = deps.locks;
    this.history = new DeckHistory(deps.repos, deps.sources);
  }

  // -------------------------------------------------------------------------
  // Decks
  // -------------------------------------------------------------------------

  async listDecks(): Promise<DeckSummaryDTO[]> {
    const decks = await this.repos.decks.list();
    return mapConcurrently(decks, async (deck) => this.summarize(await this.loadState(deck)));
  }

  async trackDeck(input: string): Promise<TrackDeckOutcome> {
    const parsed = this.parseDeckInput(input);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    const { source, ref, canonicalUrl } = parsed;

    const existing = await this.repos.decks.getBySourceExternal(ref.source, ref.externalId);
    if (existing) return { ok: true, deckId: existing.id, alreadyTracked: true, fetch: null };

    const { deck, created } = await this.createDeck(source, {
      externalId: ref.externalId,
      url: canonicalUrl,
      // Placeholders until the first fetch or capture tells us the real values.
      name: ref.externalId,
      format: '',
    });
    if (!created) return { ok: true, deckId: deck.id, alreadyTracked: true, fetch: null };

    const fetch =
      source.serverFetchStatus().state === 'available' ? await this.refresh(deck.id, 'manual') : null;
    return { ok: true, deckId: deck.id, alreadyTracked: false, fetch };
  }

  untrackDeck(deckId: string): Promise<void> {
    return this.locks.run(deckId, async () => {
      if (await this.repos.decks.delete(deckId)) this.logger.info('Deck untracked', { deckId });
    });
  }

  async getOverview(deckId: string): Promise<DeckOverviewDTO | null> {
    const deck = await this.repos.decks.getById(deckId);
    if (!deck) return null;
    const [state, commits] = await Promise.all([
      this.loadState(deck),
      this.repos.commits.listForDeck(deck.id),
    ]);
    const { head, working, diff } = state;
    const serverFetch = this.sources.require(deck.source).serverFetchStatus();
    const snapshot = state.workingSnapshot ?? state.headSnapshot;
    const commanderKeys = snapshot ? zoneCards(snapshot, 'commanders').map((card) => card.key) : [];
    let suggestedMessage = '';
    if (diff !== null) suggestedMessage = head ? suggestCommitMessage(diff) : INITIAL_VERSION_MESSAGE;
    const [recentVersions, catalog] = await Promise.all([
      this.history.versionItems(commits, commits.slice(0, RECENT_VERSION_COUNT)),
      this.history.catalogFor([...(diff ? diffCardKeys(diff) : []), ...commanderKeys]),
    ]);

    return {
      ...this.summarize(state),
      diff,
      warnings: working?.warnings ?? [],
      recentVersions,
      serverFetch,
      catalog,
      autoRefreshSuggested: this.autoRefreshSuggested(deck, working, serverFetch),
      suggestedMessage,
    };
  }

  // -------------------------------------------------------------------------
  // Ingestion: server refresh and browser capture
  // -------------------------------------------------------------------------

  refresh(deckId: string, trigger: 'manual' | 'auto'): Promise<FetchOutcome> {
    return this.locks.run(deckId, async (): Promise<FetchOutcome> => {
      const deck = await this.requireDeck(deckId);
      const source = this.sources.require(deck.source);
      const now = this.now();

      const cooldown = this.cooldownRemainingSeconds(deck, now);
      if (cooldown > 0) {
        return {
          ok: false,
          error: {
            code: 'rate-limited',
            message: `Checked ${source.displayName} moments ago. Try again in ${cooldown} s.`,
            at: now.toISOString(),
            retryAfterSeconds: cooldown,
          },
        };
      }
      const unavailable = unavailableError(source.serverFetchStatus(), now);
      if (unavailable) return { ok: false, error: unavailable };

      const result = await this.fetchAndIngest(deck, source, trigger);
      if (!result.ok) return result;
      return {
        ok: true,
        observationId: result.observation.id,
        changedSinceLastObservation: result.changed,
      };
    });
  }

  async ingestCapture(input: {
    data: unknown;
    method: Exclude<IngestMethod, 'server'>;
    track: boolean;
  }): Promise<CaptureOutcome> {
    const source = this.sources.require(CAPTURE_SOURCE_ID);
    // Both throw DeckSourceError('schema') for unusable data; callers answer 400.
    const raw = source.parseCapturedPayload(input.data);
    const normalized = source.normalizeDeck(raw);
    const parsed = source.parseDeckUrl(normalized.metadata.externalId);
    if (!parsed.ok) {
      throw new DeckSourceError('schema', `The captured deck has an invalid ${source.displayName} deck id.`, {
        source: source.id,
      });
    }
    const { externalId } = parsed.ref;

    let deck = await this.repos.decks.getBySourceExternal(source.id, externalId);
    if (!deck) {
      if (!input.track) {
        return { status: 'untracked', source: source.id, externalId, name: normalized.metadata.name };
      }
      ({ deck } = await this.createDeck(source, {
        externalId,
        url: parsed.canonicalUrl,
        name: normalized.metadata.name,
        format: normalized.metadata.format,
      }));
    }

    const deckId = deck.id;
    const { changed } = await this.locks.run(deckId, async () =>
      this.ingest(await this.requireDeck(deckId), source, raw, input.method, { normalized }),
    );
    this.logger.info('Deck captured', { deckId, method: input.method, changed });
    return { status: 'ingested', deckId, changedSinceLastObservation: changed };
  }

  // -------------------------------------------------------------------------
  // Commit
  // -------------------------------------------------------------------------

  async commit(
    deckId: string,
    input: {
      message: string;
      expectedObservationId: string;
      expectedHeadCommitId: string | null;
      tags?: string[];
    },
  ): Promise<CommitOutcome> {
    const message = normalizeMultilineText(input.message);
    const length = codePointLength(message);
    if (length === 0) return commitFailure('invalid-message', 'Write a commit message.');
    if (length > MAX_COMMIT_MESSAGE_LENGTH) {
      return commitFailure(
        'invalid-message',
        `Commit messages can be at most ${MAX_COMMIT_MESSAGE_LENGTH} characters long.`,
      );
    }
    const tags = new Set<string>();
    for (const tag of input.tags ?? []) {
      const validation = normalizeVersionTag(tag);
      if (!validation.ok) {
        return commitFailure('invalid-message', `Invalid tag ${JSON.stringify(tag)}: ${validation.reason}`);
      }
      tags.add(validation.name);
    }

    return this.locks.run(deckId, () =>
      this.commitLocked(deckId, {
        message,
        expectedObservationId: input.expectedObservationId,
        expectedHeadCommitId: input.expectedHeadCommitId,
        tags: [...tags],
      }),
    );
  }

  private async commitLocked(
    deckId: string,
    input: {
      message: string;
      expectedObservationId: string;
      expectedHeadCommitId: string | null;
      tags: string[];
    },
  ): Promise<CommitOutcome> {
    const deck = await this.requireDeck(deckId);
    const source = this.sources.require(deck.source);
    const changedMessage = `The deck changed on ${source.displayName} since you reviewed it. Review the new changes and commit again.`;

    const latest = await this.repos.observations.latestForDeck(deckId);
    if (!latest) {
      return commitFailure(
        'no-working-state',
        `Nothing has been fetched from ${source.displayName} yet. Refresh the deck or send it with the bookmarklet first.`,
      );
    }
    const reviewed =
      latest.id === input.expectedObservationId
        ? latest
        : await this.repos.observations.getById(input.expectedObservationId);
    if (reviewed?.deckId !== deckId) return reviewOutdated();
    if (!(await this.sameDeckState(this.repos, reviewed.snapshotHash, latest.snapshotHash))) {
      return commitFailure('stale', changedMessage);
    }

    // Refuse a commit that cannot succeed (HEAD moved, nothing to commit) before asking
    // the source; the transaction below checks again, authoritatively.
    const target = await this.commitTarget(this.repos, deck, source, reviewed, input.expectedHeadCommitId);
    if (!target.ok) return target.outcome;

    // Fetch on commit: make sure the reviewed state is still what the source has.
    // Failures (blocked, rate limited, offline, ...) are recorded and logged, and the
    // reviewed state is committed: it is a real observation the user has reviewed.
    if (source.serverFetchStatus().state === 'available') {
      // The reviewed observation must survive the pruning of this ingest.
      const fresh = await this.fetchAndIngest(deck, source, 'commit', [reviewed.id]);
      const diff = fresh.ok
        ? await this.deckStateDiff(this.repos, reviewed.snapshotHash, fresh.observation.snapshotHash)
        : null;
      if (diff && !diff.isEmpty) {
        // Committing the reviewed state would drop the primer the source just returned.
        const primerOnly =
          diff.primer.status === 'captured' && diff.changes.length === 0 && diff.deck.length === 0;
        return commitFailure(
          'stale',
          primerOnly
            ? `The primer is now available on ${source.displayName}. Review it and commit again.`
            : changedMessage,
        );
      }
    }

    let outcome: CommitOutcome;
    try {
      outcome = await this.repos.transaction((tx) => this.insertCommit(tx, deck, source, reviewed, input));
    } catch (error) {
      // A concurrent writer (e.g. another process) moved the branch head first.
      if (isRepositoryError(error, 'conflict')) return headMoved();
      throw error;
    }
    if (outcome.ok) {
      this.logger.info('Version committed', {
        deckId,
        sequence: outcome.version.sequence,
        commitId: outcome.version.commitId,
        ingestMethod: reviewed.ingestMethod,
      });
    }
    return outcome;
  }

  /**
   * The deck's HEAD branch when committing `reviewed` on it can succeed; otherwise why
   * not: HEAD is no longer `expectedHeadCommitId`, or `reviewed` matches HEAD.
   */
  private async commitTarget(
    repos: Repositories,
    deck: DeckRecord,
    source: DeckSource,
    reviewed: ObservationRecord,
    expectedHeadCommitId: string | null,
  ): Promise<{ ok: true; branch: BranchRecord } | { ok: false; outcome: CommitOutcome }> {
    const branch = await repos.branches.getByName(deck.id, deck.headBranchName);
    if (!branch) throw new Error(`Deck ${deck.id} has no ${deck.headBranchName} branch`);
    const parentId = branch.headCommitId;
    if (parentId !== expectedHeadCommitId) return { ok: false, outcome: headMoved() };
    if (parentId !== null) {
      const head = requireRecord(await repos.commits.getById(parentId), `Commit ${parentId}`);
      if (await this.sameDeckState(repos, head.snapshotHash, reviewed.snapshotHash)) {
        return {
          ok: false,
          outcome: commitFailure(
            'nothing-to-commit',
            `The deck on ${source.displayName} matches v${head.sequence}. There is nothing to commit.`,
          ),
        };
      }
    }
    return { ok: true, branch };
  }

  /**
   * Commits the reviewed observation on the deck's HEAD branch. Runs inside a
   * transaction: re-verifies HEAD and refuses empty commits ({@link commitTarget}),
   * inserts the commit, moves the head (compare-and-set) and applies the tags.
   */
  private async insertCommit(
    tx: Repositories,
    deck: DeckRecord,
    source: DeckSource,
    reviewed: ObservationRecord,
    input: { message: string; expectedHeadCommitId: string | null; tags: string[] },
  ): Promise<CommitOutcome> {
    const target = await this.commitTarget(tx, deck, source, reviewed, input.expectedHeadCommitId);
    if (!target.ok) return target.outcome;
    const { branch } = target;
    const parentId = branch.headCommitId;
    // Another process may have pruned the reviewed observation (and its raw payload).
    if (!(await tx.observations.getById(reviewed.id))) return reviewOutdated();

    const sequence = ((await tx.commits.maxSequence(deck.id)) ?? 0) + 1;
    const createdAt = this.now().toISOString();
    const id = commitId({
      deck: `${deck.source}:${deck.externalId}`,
      snapshotHash: reviewed.snapshotHash,
      parentId,
      createdAt,
      sourceVersion: reviewed.sourceVersion,
      message: input.message,
    });
    const commit = await tx.commits.insert({
      id,
      deckId: deck.id,
      branchId: branch.id,
      sequence,
      parentId,
      snapshotHash: reviewed.snapshotHash,
      rawBlobHash: reviewed.rawBlobHash,
      message: input.message,
      createdAt,
      ingestMethod: reviewed.ingestMethod,
      fetchedAt: reviewed.fetchedAt,
      sourceVersion: reviewed.sourceVersion,
      sourceUpdatedAt: reviewed.sourceUpdatedAt,
      sourceMetadata: reviewed.sourceMetadata,
    });
    await tx.branches.setHead(branch.id, commit.id, { expectedHeadCommitId: parentId });
    for (const tag of input.tags) await tx.tags.add(commit.id, tag);
    return { ok: true, version: toVersionRefDTO(commit) };
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  listVersions(deckId: string, options: { tag?: string } = {}): Promise<VersionListItemDTO[]> {
    return this.history.listVersions(deckId, options.tag);
  }

  async getVersion(deckId: string, sequence: number): Promise<VersionDetailDTO | null> {
    const deck = await this.repos.decks.getById(deckId);
    if (!deck) return null;
    const [detail, state] = await Promise.all([
      this.history.versionDetail(deckId, sequence),
      this.loadState(deck),
    ]);
    if (!detail) return null;
    return { deck: this.summarize(state), ...detail };
  }

  async compare(deckId: string, from: VersionRef, to: VersionRef): Promise<CompareDTO | null> {
    const deck = await this.repos.decks.getById(deckId);
    if (!deck) return null;
    const state = await this.loadState(deck);
    const [fromSide, toSide] = await Promise.all([this.resolveRef(state, from), this.resolveRef(state, to)]);
    if (!fromSide || !toSide) return null;
    return {
      deck: this.summarize(state),
      ...(await this.history.comparison(deckId, fromSide, toSide)),
      hasWorking: state.working !== null,
    };
  }

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------

  async searchCards(
    deckId: string,
    query: string,
    limit = DEFAULT_CARD_SEARCH_LIMIT,
  ): Promise<CardSearchResultDTO[]> {
    // The search is scoped to the workspace's deck by itself; the lookup keeps "unknown
    // deck" explicit (and costs no extra round trip).
    const [deck, results] = await Promise.all([
      this.repos.decks.getById(deckId),
      this.history.searchCards(deckId, query, limit, true),
    ]);
    return deck ? results : [];
  }

  async cardHistory(
    deckId: string,
    card: string,
    options: { includeWorking?: boolean } = {},
  ): Promise<CardHistoryDTO | null> {
    const deck = await this.repos.decks.getById(deckId);
    if (!deck) return null;
    const state = await this.loadState(deck);
    const { working, workingSnapshot } = state;
    const found = await this.history.cardHistory(
      deckId,
      card,
      options.includeWorking !== false && working && workingSnapshot
        ? {
            fetchedAt: working.fetchedAt,
            snapshot: workingSnapshot,
            label: `Current ${this.sources.require(deck.source).displayName} deck`,
          }
        : null,
    );
    if (!found) return null;
    return { deck: this.summarize(state), ...found };
  }

  // -------------------------------------------------------------------------
  // Restore, tags, notes
  // -------------------------------------------------------------------------

  async restoreExport(deckId: string, sequence: number): Promise<RestoreDTO | null> {
    const deck = await this.repos.decks.getById(deckId);
    if (!deck) return null;
    const [restore, state] = await Promise.all([
      this.history.restoreExport(deck, sequence, 'source-deck'),
      this.loadState(deck),
    ]);
    if (!restore) return null;
    return {
      deck: this.summarize(state),
      version: toVersionRefDTO(restore.commit),
      export: restore.export,
    };
  }

  async addTag(deckId: string, sequence: number, tag: string): Promise<TagOutcome> {
    const commit = await this.repos.commits.getBySequence(deckId, sequence);
    if (!commit) return { ok: false, reason: versionNotFound(sequence) };
    const validation = normalizeVersionTag(tag);
    if (!validation.ok) return { ok: false, reason: validation.reason };
    await this.repos.tags.add(commit.id, validation.name);
    return { ok: true, tags: await this.repos.tags.listForCommit(commit.id) };
  }

  async removeTag(deckId: string, sequence: number, tag: string): Promise<TagOutcome> {
    const commit = await this.repos.commits.getBySequence(deckId, sequence);
    if (!commit) return { ok: false, reason: versionNotFound(sequence) };
    const validation = normalizeVersionTag(tag);
    if (!validation.ok) return { ok: false, reason: validation.reason };
    await this.repos.tags.remove(commit.id, validation.name);
    return { ok: true, tags: await this.repos.tags.listForCommit(commit.id) };
  }

  listTags(deckId: string): Promise<TagCountDTO[]> {
    return this.history.listTags(deckId);
  }

  async setNote(deckId: string, sequence: number, text: string): Promise<CommitNoteDTO | null> {
    const commit = await this.repos.commits.getBySequence(deckId, sequence);
    if (!commit) throw new ServiceError('not-found', versionNotFound(sequence));
    const note = normalizeMultilineText(text);
    if (note === '') {
      await this.repos.notes.delete(commit.id, FREE_TEXT_NOTE_KIND);
      return null;
    }
    if (codePointLength(note) > MAX_NOTE_LENGTH) {
      throw new ServiceError('invalid-input', `Notes can be at most ${MAX_NOTE_LENGTH} characters long.`);
    }
    return toCommitNoteDTO(await this.repos.notes.upsert(commit.id, FREE_TEXT_NOTE_KIND, { text: note }));
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  primerToMarkdown(source: string, primer: string): string {
    return this.sources.get(source)?.primerToMarkdown(primer) ?? primer;
  }

  getSetupInfo(): SetupInfoDTO {
    return setupInfo(this.config, this.sources);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async requireDeck(deckId: string): Promise<DeckRecord> {
    const deck = await this.repos.decks.getById(deckId);
    if (!deck) throw new ServiceError('not-found', 'This deck is not tracked (it may have been removed).');
    return deck;
  }

  /** The first source that accepts the input, or the first source's rejection reason. */
  private parseDeckInput(
    input: string,
  ): { ok: true; source: DeckSource; ref: DeckRef; canonicalUrl: string } | { ok: false; reason: string } {
    let reason: string | undefined;
    for (const source of this.sources.all()) {
      const parsed = source.parseDeckUrl(input);
      if (parsed.ok) return { ok: true, source, ref: parsed.ref, canonicalUrl: parsed.canonicalUrl };
      reason ??= parsed.reason;
    }
    return { ok: false, reason: reason ?? 'No deck sources are configured.' };
  }

  /** Creates a deck; when another request created it first, returns that one. */
  private async createDeck(
    source: DeckSource,
    info: { externalId: string; url: string; name: string; format: string },
  ): Promise<{ deck: DeckRecord; created: boolean }> {
    try {
      const deck = await this.repos.decks.create({ source: source.id, ...info });
      this.logger.info('Deck tracked', { deckId: deck.id, source: source.id, externalId: info.externalId });
      return { deck, created: true };
    } catch (error) {
      const existing = isRepositoryError(error, 'conflict')
        ? await this.repos.decks.getBySourceExternal(source.id, info.externalId)
        : null;
      if (!existing) throw error;
      return { deck: existing, created: false };
    }
  }

  /**
   * Fetches the deck server-side and ingests it, keeping the observations in `retain`
   * (see {@link ingest}). Records the attempt, and the error of a failed attempt
   * (cleared again by a success). Never throws for fetch failures.
   */
  private async fetchAndIngest(
    deck: DeckRecord,
    source: DeckSource,
    reason: FetchReason,
    retain: readonly string[] = [],
  ): Promise<FetchResult> {
    const at = this.now().toISOString();
    await this.repos.decks.recordFetchAttempt(deck.id, at);
    try {
      // The request to the source happens before (never inside) the ingest transaction.
      const raw = await source.getDeck({ source: deck.source, externalId: deck.externalId });
      const ingested = await this.ingest(deck, source, raw, 'server', { retain });
      await this.repos.decks.recordFetchError(deck.id, null);
      this.logger.debug('Deck fetched', { deckId: deck.id, reason, changed: ingested.changed });
      return { ok: true, ...ingested };
    } catch (error) {
      return { ok: false, error: await this.fetchFailure(deck, source, reason, at, error) };
    }
  }

  private async fetchFailure(
    deck: DeckRecord,
    source: DeckSource,
    reason: FetchReason,
    at: string,
    error: unknown,
  ): Promise<FetchErrorDTO> {
    if (isDeckSourceError(error)) {
      const record: FetchErrorRecord = {
        code: error.code,
        message: error.message,
        at,
        retryAfterSeconds: error.retryAfterSeconds ?? null,
      };
      await this.repos.decks.recordFetchError(deck.id, record);
      this.logger.warn('Fetching the deck failed', {
        deckId: deck.id,
        source: deck.source,
        externalId: deck.externalId,
        reason,
        code: error.code,
        status: error.status ?? null,
        retryAfterSeconds: record.retryAfterSeconds,
      });
      return toFetchErrorDTO(record);
    }
    // Aborts and unexpected failures: log the details, show a generic message.
    this.logger.error('Unexpected error while fetching the deck', { deckId: deck.id, reason, error });
    return {
      code: 'unavailable',
      message: `Something went wrong while checking ${source.displayName}. Try again in a moment.`,
      at,
      retryAfterSeconds: null,
    };
  }

  /**
   * Stores a payload as the deck's newest observation (raw payload, snapshot, card
   * facts, observation and cached deck info in one transaction). Shared by server
   * fetches and browser captures.
   *
   * Superseded observations are pruned in the same transaction, with the snapshots and
   * raw payloads only they referenced (raw payloads differ on almost every fetch, so
   * they would otherwise pile up). Kept are the new observation, the one it supersedes
   * (a page rendered just before this ingest can still commit it) and `options.retain`
   * (an observation a commit in progress is about to record).
   *
   * @throws {DeckSourceError} `schema` when the payload is unusable or describes another deck.
   */
  private async ingest(
    deck: DeckRecord,
    source: DeckSource,
    raw: RawSourcePayload,
    method: IngestMethod,
    options: { normalized?: NormalizedDeck; retain?: readonly string[] } = {},
  ): Promise<Ingested> {
    const { metadata, snapshot, catalog, warnings } = options.normalized ?? source.normalizeDeck(raw);
    if (metadata.source !== deck.source || metadata.externalId !== deck.externalId) {
      throw new DeckSourceError(
        'schema',
        `${source.displayName} returned deck ${metadata.externalId} instead of ${deck.externalId}.`,
        { source: source.id },
      );
    }
    const fetchedAt = this.now().toISOString();
    return this.repos.transaction(async (tx) => {
      const previous = await tx.observations.latestForDeck(deck.id);
      const rawBlobHash = await tx.rawBlobs.put({ mediaType: raw.mediaType, data: raw.data });
      const snapshotHash = await tx.snapshots.put(snapshot);
      await tx.catalog.upsertMany(catalog);
      const observation = await tx.observations.insert({
        deckId: deck.id,
        snapshotHash,
        rawBlobHash,
        ingestMethod: method,
        fetchedAt,
        sourceVersion: metadata.version ?? null,
        sourceUpdatedAt: metadata.lastUpdatedAt ?? null,
        sourceMetadata: metadata,
        warnings,
      });
      await tx.decks.updateCachedInfo(deck.id, {
        name: metadata.name.trim() === '' ? deck.name : metadata.name,
        format: metadata.format,
        url: metadata.url,
      });
      const changed =
        previous === null || !(await this.sameDeckState(tx, previous.snapshotHash, snapshotHash));
      await tx.observations.pruneForDeck(deck.id, [
        observation.id,
        ...(previous ? [previous.id] : []),
        ...(options.retain ?? []),
      ]);
      return { observation, changed };
    });
  }

  /**
   * Whether the stored snapshot `after` holds nothing that `before` does not record
   * (empty diff `before` → `after`). Directional: a primer that only `after` has is a
   * difference, one that only `before` has is not (see `primerChange`).
   */
  private async sameDeckState(repos: Repositories, before: string, after: string): Promise<boolean> {
    return (await this.deckStateDiff(repos, before, after))?.isEmpty ?? true;
  }

  /** Diff of two stored snapshots; `null` when they are the same snapshot. */
  private async deckStateDiff(repos: Repositories, before: string, after: string): Promise<DeckDiff | null> {
    if (before === after) return null;
    const snapshots = await repos.snapshots.getMany([before, after]);
    return diffSnapshots(requireSnapshot(snapshots, before), requireSnapshot(snapshots, after));
  }

  private async loadState(deck: DeckRecord): Promise<DeckState> {
    const [head, working, versionCount] = await Promise.all([
      this.repos.commits.head(deck.id),
      this.repos.observations.latestForDeck(deck.id),
      this.repos.commits.count(deck.id),
    ]);
    const hashes: string[] = [];
    if (head) hashes.push(head.snapshotHash);
    if (working) hashes.push(working.snapshotHash);
    const snapshots = await this.repos.snapshots.getMany(hashes);
    const headSnapshot = head ? requireSnapshot(snapshots, head.snapshotHash) : null;
    const workingSnapshot = working ? requireSnapshot(snapshots, working.snapshotHash) : null;
    const diff = workingSnapshot
      ? diffSnapshots(headSnapshot ?? emptySnapshot(workingSnapshot.deck), workingSnapshot)
      : null;
    return { deck, head, headSnapshot, working, workingSnapshot, diff, versionCount };
  }

  private summarize(state: DeckState): DeckSummaryDTO {
    const { deck, head, working, diff } = state;
    const snapshot = state.workingSnapshot ?? state.headSnapshot;
    return {
      id: deck.id,
      source: deck.source,
      externalId: deck.externalId,
      url: deck.url,
      name: deck.name,
      format: deck.format,
      commanders: snapshot ? commanderNames(snapshot) : [],
      status: deckStatus(head !== null, diff),
      head: head ? toVersionRefDTO(head) : null,
      working: working ? toObservationDTO(working) : null,
      lastFetchError: deck.lastFetchError ? toFetchErrorDTO(deck.lastFetchError) : null,
      workingStats: head && diff ? diff.stats : null,
      versionCount: state.versionCount,
    };
  }

  /**
   * Resolves a version reference of `compare`: `working` is the deck's latest
   * observation, everything else is committed history (see {@link DeckHistory.resolveCommitted}).
   */
  private async resolveRef(state: DeckState, ref: VersionRef): Promise<ResolvedSide | null> {
    const parsed = parseVersionRef(ref);
    if (!parsed) return null;
    if (parsed.kind !== 'working') return this.history.resolveCommitted(state.deck.id, parsed, state.head);
    return state.working && state.workingSnapshot
      ? {
          side: { kind: 'working', observation: toObservationDTO(state.working) },
          snapshot: state.workingSnapshot,
        }
      : null;
  }

  /** Seconds until the per-deck refresh cooldown ends (0 when not cooling down). */
  private cooldownRemainingSeconds(deck: DeckRecord, now: Date): number {
    if (deck.lastFetchAttemptAt === null) return 0;
    const cooldownMs = this.config.REFRESH_COOLDOWN_SECONDS * 1000;
    const elapsedMs = now.getTime() - Date.parse(deck.lastFetchAttemptAt);
    // A clock that went backwards (negative elapsed time) never blocks refreshing.
    if (!(elapsedMs >= 0 && elapsedMs < cooldownMs)) return 0;
    return Math.ceil((cooldownMs - elapsedMs) / 1000);
  }

  /**
   * True when the client should refresh in the background after rendering: server
   * fetching works, the deck is not cooling down, the source's `Retry-After` from the
   * deck's last (rate-limited) attempt has passed, and the deck was last checked (by a
   * fetch attempt or any observation) at least `AUTO_REFRESH_AFTER_SECONDS` ago.
   * Failed attempts count as checks, so a failing deck is not retried on every load.
   */
  private autoRefreshSuggested(
    deck: DeckRecord,
    working: ObservationRecord | null,
    serverFetch: ServerFetchStatus,
  ): boolean {
    if (serverFetch.state !== 'available') return false;
    const now = this.now();
    if (this.cooldownRemainingSeconds(deck, now) > 0) return false;
    const error = deck.lastFetchError;
    if (error?.code === 'rate-limited' && error.retryAfterSeconds !== null) {
      const retryAt = Date.parse(error.at) + error.retryAfterSeconds * 1000;
      if (now.getTime() < retryAt) return false;
    }
    const checks = [working?.fetchedAt, deck.lastFetchAttemptAt ?? undefined]
      .flatMap((at) => (at === undefined ? [] : [Date.parse(at)]))
      .filter((ms) => !Number.isNaN(ms));
    if (checks.length === 0) return true;
    return now.getTime() - Math.max(...checks) >= this.config.AUTO_REFRESH_AFTER_SECONDS * 1000;
  }
}

/** The `blocked` error returned without any request when server fetching is unavailable. */
function unavailableError(status: ServerFetchStatus, now: Date): FetchErrorDTO | null {
  switch (status.state) {
    case 'available':
      return null;
    case 'disabled':
      return { code: 'blocked', message: status.reason, at: now.toISOString(), retryAfterSeconds: null };
    case 'blocked': {
      const retryAfterMs = Date.parse(status.retryAt) - now.getTime();
      return {
        code: 'blocked',
        message: status.reason,
        at: now.toISOString(),
        retryAfterSeconds: Number.isNaN(retryAfterMs) ? null : Math.max(0, Math.ceil(retryAfterMs / 1000)),
      };
    }
  }
}

function commitFailure(reason: CommitFailureReason, message: string): CommitOutcome {
  return { ok: false, reason, message };
}

/** The reviewed observation no longer exists (superseded and pruned) or is another deck's. */
function reviewOutdated(): CommitOutcome {
  return commitFailure(
    'stale',
    'The changes you reviewed are out of date. Review them again before committing.',
  );
}

function headMoved(): CommitOutcome {
  return commitFailure(
    'head-moved',
    'Another version was committed while you were reviewing. Review the changes again.',
  );
}

function versionNotFound(sequence: number): string {
  return `Version v${sequence} does not exist.`;
}

/** NFC, LF line endings, surrounding whitespace trimmed. */
function normalizeMultilineText(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n').trim();
}

function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length++;
  return length;
}
