/**
 * Typed URL builders for every page of the app.
 *
 * Next.js typed routes validate literal hrefs; dynamic hrefs need an `as Route` cast.
 * Keeping all casts here means every link in the UI goes through one audited place,
 * and path segments are always URL-encoded.
 *
 * A deck's pages exist twice (ADR 0007): for its owner under `/decks/<deckId>` and,
 * read-only, for anyone with a share link under `/s/<token>`. Components never build deck
 * URLs themselves: they are given a {@link DeckScope} and link with {@link deckRoutes}.
 */
import type { Route } from 'next';

import {
  CAPTURE_MODE_PARAM,
  CAPTURE_PAGE_PATH,
  CAPTURE_PASTE_MODE,
  type CaptureFormError,
} from '@/integrations/moxfield/capture-protocol';
import { CLAIM_PATH, signInPath } from '@/server/auth/paths';
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
  capturePaste: (query: { error?: CaptureFormError } = {}): Route =>
    withQuery(CAPTURE_PAGE_PATH, { [CAPTURE_MODE_PARAM]: CAPTURE_PASTE_MODE, error: query.error }),

  // Account pages, at the paths the server prints and redirects to (`src/server/auth/paths.ts`).

  /** The sign-in page; `next` is a local path to return to afterwards. */
  signIn: (next?: string): Route => signInPath(next) as Route,
  claim: (): Route => CLAIM_PATH,
  account: (): Route => '/account',
  admin: (): Route => '/admin',

  /**
   * The owner's deck page (Status). `captured` greets a deck just sent from the browser,
   * `relinked` a deck that now follows another Moxfield deck (both, when a capture
   * continued the deck). Every other page of a deck, and the deck's pages for share link
   * viewers, are built by {@link deckRoutes}.
   */
  deck: (deckId: string, query: { captured?: boolean; relinked?: boolean } = {}): Route =>
    withQuery(deckBase({ kind: 'owner', deckId }), {
      captured: query.captured === true ? '1' : undefined,
      relinked: query.relinked === true ? '1' : undefined,
    }),

  /** The owner's share links of a deck (ADR 0007). Owner only, so not a {@link DeckRoutes} page. */
  deckShare: (deckId: string): Route => `${deckBase({ kind: 'owner', deckId })}/share` as Route,
} as const;

/**
 * Whose pages of a deck: its owner's (`/decks/<deckId>/…`) or the read-only pages a share
 * link opens (`/s/<token>/…`, ADR 0007). Plain data, so a server component can hand it to
 * a client component (functions cannot cross that boundary). Deck components take it as
 * their `scope` prop and build every link with {@link deckRoutes}, so the same component
 * links within the owner's pages or within the share link's.
 */
export type DeckScope =
  { readonly kind: 'owner'; readonly deckId: string } | { readonly kind: 'shared'; readonly token: string };

/**
 * URL builders of the pages every deck has, for owners and share link viewers alike (the
 * owner-only pages are in {@link routes}). Paths below the deck are identical in both
 * scopes; only the base differs.
 */
export interface DeckRoutes {
  /** Which deck pages these are. */
  readonly scope: DeckScope;
  /** The deck's first page: Status for its owner, the overview for viewers. */
  overview: () => Route;
  history: (query?: { tag?: string }) => Route;
  version: (sequence: number, tab?: VersionTab, hash?: string) => Route;
  /** `section: 'primer'` links straight to the primer block of the restore page. */
  restore: (sequence: number, section?: 'primer') => Route;
  /** The plain-text download of a version's restore export (a route handler, not a page). */
  restoreText: (sequence: number) => string;
  compare: (query?: { from?: VersionRef; to?: VersionRef; hash?: string }) => Route;
  cards: (query?: { q?: string }) => Route;
  card: (cardKey: string, query?: { all?: boolean }) => Route;
}

/** `/decks/<deckId>` or `/s/<token>`, encoded. */
function deckBase(scope: DeckScope): string {
  return scope.kind === 'owner' ? `/decks/${enc(scope.deckId)}` : `/s/${enc(scope.token)}`;
}

/** The pages of the deck that `scope` names. */
export function deckRoutes(scope: DeckScope): DeckRoutes {
  const base = deckBase(scope);
  return {
    scope,
    overview: () => base as Route,
    history: (query = {}) => withQuery(`${base}/history`, { tag: query.tag }),
    version: (sequence, tab, hash) =>
      withQuery(`${base}/versions/${sequence}`, { tab: tab === 'changes' ? undefined : tab }, hash),
    restore: (sequence, section) =>
      `${base}/versions/${sequence}/restore${section === 'primer' ? '#restore-primer' : ''}` as Route,
    restoreText: (sequence) => `${base}/versions/${sequence}/restore.txt`,
    compare: (query = {}) => withQuery(`${base}/compare`, { from: query.from, to: query.to }, query.hash),
    cards: (query = {}) => withQuery(`${base}/cards`, { q: query.q }),
    card: (cardKey, query = {}) =>
      withQuery(`${base}/cards/${enc(cardKey)}`, { all: query.all === true ? '1' : undefined }),
  };
}

/**
 * The page a GET form opens when it is submitted: its `action` with the form's fields as
 * the query, as a browser builds it (the action's own query and fragment are replaced;
 * file fields, which a GET form cannot send, are left out). Used by `Form`
 * (`src/components/ui/navigation.tsx`) to navigate on the client.
 */
export function formSubmissionRoute(action: Route, fields: Iterable<[string, FormDataEntryValue]>): Route {
  const params = new URLSearchParams();
  for (const [name, value] of fields) {
    if (typeof value === 'string') params.append(name, value);
  }
  const path = action.replace(/[?#].*$/s, '');
  const search = params.toString();
  return (search === '' ? path : `${path}?${search}`) as Route;
}

/** The owner's pages of a deck (`/decks/<deckId>/…`). */
export function ownerDeckRoutes(deckId: string): DeckRoutes {
  return deckRoutes({ kind: 'owner', deckId });
}

/**
 * The read-only pages a share link opens (`/s/<token>/…`). `token` is the link's secret:
 * only ever build these from the token of the page being viewed.
 */
export function sharedDeckRoutes(token: string): DeckRoutes {
  return deckRoutes({ kind: 'shared', token });
}
