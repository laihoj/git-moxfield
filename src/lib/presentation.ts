/**
 * Shared wording for domain states, so the deck list, the status panel and the
 * version pages describe the same thing with the same words (docs/ux.md).
 */
import { isRecord } from '@/core/guards';
import { upperFirst } from '@/core/text';
import type { DeckSourceErrorCode, IngestMethod } from '@/integrations/deck-source';
import type {
  CommitNoteDTO,
  DeckStatus,
  DeckSummaryDTO,
  SharedDeckDTO,
  VersionRefDTO,
} from '@/server/services/types';

import { versionLabel } from './format';

export type StatusTone = 'pending' | 'accent' | 'neutral' | 'success';

export interface StatusPresentation {
  /** Short label, e.g. `Uncommitted changes`. */
  label: string;
  tone: StatusTone;
}

/** Label and tone of a deck status. `head` is the latest version, when there is one. */
export function describeStatus(status: DeckStatus, head: VersionRefDTO | null): StatusPresentation {
  switch (status) {
    case 'never-fetched':
      return { label: 'Waiting for the first snapshot from Moxfield', tone: 'pending' };
    case 'no-versions':
      return { label: 'Not committed yet', tone: 'accent' };
    case 'uncommitted':
      return { label: 'Uncommitted changes', tone: 'accent' };
    case 'cosmetic-only':
      return { label: 'Only printing changes', tone: 'neutral' };
    case 'clean':
      return {
        label: head === null ? 'Up to date' : `Up to date with ${versionLabel(head.sequence)}`,
        tone: 'success',
      };
  }
}

/** Title shown for a deck whose name is not known yet. */
export const UNNAMED_DECK_TITLE = 'New Moxfield deck';

/**
 * Whether the deck has no real name yet: until the first snapshot arrives, a tracked
 * deck only knows its Moxfield public id (`7O1sCuIti0igU6Us_Jhadg`), which is stored as
 * its name but must not be shown as one.
 */
export function isUnnamedDeck(deck: Pick<DeckSummaryDTO, 'name' | 'externalId' | 'status'>): boolean {
  return deck.status === 'never-fetched' && deck.name === deck.externalId;
}

/** The deck's name for titles and labels: `New Moxfield deck` until its name is known. */
export function deckTitle(deck: Pick<DeckSummaryDTO, 'name' | 'externalId' | 'status'>): string {
  return isUnnamedDeck(deck) ? UNNAMED_DECK_TITLE : deck.name;
}

/** A page title: `History · Blue Farm`, or just `History` while the deck is not known. */
export function deckPageTitle(section: string, deckName: string | null): string {
  return deckName === null ? section : `${section} · ${deckName}`;
}

/** Title shown for a shared deck whose latest version has no name. */
export const UNTITLED_DECK_TITLE = 'Untitled deck';

/**
 * A shared deck's name for titles and labels: its latest version's, `New Moxfield deck`
 * before the first version and `Untitled deck` for a version without a name. Viewers see
 * committed facts only, and never where the deck lives on Moxfield, so its Moxfield id
 * never stands in for a name.
 */
export function sharedDeckTitle(deck: Pick<SharedDeckDTO, 'name' | 'head'>): string {
  if (deck.head === null) return UNNAMED_DECK_TITLE;
  return deck.name.trim() === '' ? UNTITLED_DECK_TITLE : deck.name;
}

/** How a deck state reached git-moxfield, as shown on version pages. */
export function describeIngestMethod(method: IngestMethod): string {
  switch (method) {
    case 'server':
      return 'Fetched by git-moxfield';
    case 'browser-capture':
      return 'Sent with the bookmarklet';
    case 'manual-paste':
      return 'Pasted manually';
  }
}

/** Short heading for a fetch error code; the error's own message carries the details. */
export function describeFetchError(code: DeckSourceErrorCode): string {
  switch (code) {
    case 'invalid-ref':
      return 'Not a valid Moxfield deck';
    case 'not-found':
      return 'Deck not found on Moxfield';
    case 'forbidden':
      return 'The deck is private';
    case 'blocked':
      return 'Moxfield blocked the server';
    case 'rate-limited':
      return 'Moxfield asked us to slow down';
    case 'unavailable':
      return 'Moxfield is unavailable';
    case 'timeout':
      return 'Moxfield did not answer in time';
    case 'network':
      return 'Could not reach Moxfield';
    case 'schema':
      return 'Moxfield sent data git-moxfield does not understand';
  }
}

/** Format id (`commander`) as shown to users (`Commander`). */
export function formatLabel(format: string): string {
  if (format === '') return '';
  if (format.toLowerCase() === 'cedh') return 'cEDH';
  return upperFirst(format);
}

/**
 * Extracts the text of a free-text version note. Notes are stored as JSON (`kind` +
 * data); text notes are `{ text }`, but a bare string is accepted too.
 */
export function noteText(data: unknown): string {
  if (typeof data === 'string') return data;
  return isRecord(data) && typeof data.text === 'string' ? data.text : '';
}

/**
 * The free-text note among a version's notes (those of `kind`): its text, `''` without
 * one, and when it was last changed.
 */
export function freeTextNote(
  notes: readonly CommitNoteDTO[],
  kind: string,
): { text: string; updatedAt: string | null } {
  const note = notes.find((entry) => entry.kind === kind);
  return { text: note === undefined ? '' : noteText(note.data), updatedAt: note?.updatedAt ?? null };
}
