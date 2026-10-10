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

/**
 * Why the Connect Moxfield page is opened right after signing in (`/setup?welcome=…`),
 * so it can greet the user and lead with creating a bookmarklet: a new account from an
 * invite, the first admin (who may have adopted an existing installation's decks), or a
 * user back from a recovery link.
 */
export type WelcomeReason = 'invite' | 'claimed' | 'claimed-local' | 'recovery';

export const WELCOME_REASONS: readonly WelcomeReason[] = ['invite', 'claimed', 'claimed-local', 'recovery'];

export const routes = {
  home: (): Route => '/',
  setup: (query: { welcome?: WelcomeReason } = {}): Route => withQuery('/setup', { welcome: query.welcome }),
  capturePaste: (): Route => '/capture?mode=paste',

  // Account pages. The server prints the same paths (`src/server/auth/paths.ts`); a test
  // keeps the two in step.

  /** The sign-in page; `next` is a local path to return to afterwards. */
  signIn: (next?: string): Route => withQuery('/signin', { next: next === '/' ? undefined : next }),
  claim: (): Route => '/claim',
  account: (): Route => '/account',
  admin: (): Route => '/admin',

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
