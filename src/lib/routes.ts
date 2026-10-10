/**
 * Typed URL builders for every page of the app.
 *
 * Next.js typed routes validate literal hrefs; dynamic hrefs need an `as Route` cast.
 * Keeping all casts here means every link in the UI goes through one audited place,
 * and path segments are always URL-encoded.
 */
import type { Route } from 'next';

import type { VersionRef } from '@/server/services/contract';

const enc = encodeURIComponent;

function withQuery(path: string, query: Record<string, string | undefined>, hash?: string): Route {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const search = params.toString();
  const fragment = hash === undefined ? '' : `#${encodeURIComponent(hash)}`;
  return `${search === '' ? path : `${path}?${search}`}${fragment}` as Route;
}

export type VersionTab = 'changes' | 'deck' | 'primer';

export const routes = {
  home: (): Route => '/',
  setup: (): Route => '/setup',
  capturePaste: (): Route => '/capture?mode=paste',

  deck: (deckId: string, query: { captured?: boolean } = {}): Route =>
    withQuery(`/decks/${enc(deckId)}`, { captured: query.captured === true ? '1' : undefined }),

  history: (deckId: string, query: { tag?: string } = {}): Route =>
    withQuery(`/decks/${enc(deckId)}/history`, { tag: query.tag }),

  version: (deckId: string, sequence: number, tab?: VersionTab, hash?: string): Route =>
    withQuery(
      `/decks/${enc(deckId)}/versions/${sequence}`,
      { tab: tab === 'changes' ? undefined : tab },
      hash,
    ),

  /** `section: 'primer'` links straight to the primer block of the restore page. */
  restore: (deckId: string, sequence: number, section?: 'primer'): Route =>
    `/decks/${enc(deckId)}/versions/${sequence}/restore${section === 'primer' ? '#restore-primer' : ''}` as Route,

  restoreText: (deckId: string, sequence: number): string =>
    `/decks/${enc(deckId)}/versions/${sequence}/restore.txt`,

  compare: (deckId: string, query: { from?: VersionRef; to?: VersionRef; hash?: string } = {}): Route =>
    withQuery(`/decks/${enc(deckId)}/compare`, { from: query.from, to: query.to }, query.hash),

  cards: (deckId: string, query: { q?: string } = {}): Route =>
    withQuery(`/decks/${enc(deckId)}/cards`, { q: query.q }),

  card: (deckId: string, cardKey: string, query: { all?: boolean } = {}): Route =>
    withQuery(`/decks/${enc(deckId)}/cards/${enc(cardKey)}`, { all: query.all === true ? '1' : undefined }),
} as const;
