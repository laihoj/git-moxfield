import { describe, expect, it } from 'vitest';

import { CLAIM_PATH, SHARED_DECK_PATH, SIGN_IN_PATH, sharedDeckPath, signInPath } from '@/server/auth/paths';

import {
  deckRoutes,
  formSubmissionRoute,
  ownerDeckRoutes,
  routes,
  sharedDeckRoutes,
  WELCOME_REASONS,
  type DeckRoutes,
} from './routes';

/**
 * The server prints and redirects to the account pages (`src/server/auth/paths.ts`); the
 * UI's builders must produce exactly the same paths.
 */
describe('account routes', () => {
  it.each([undefined, '/', '/decks/abc', '/decks/abc/versions/3?tab=deck', '/capture?mode=paste'])(
    'builds the same sign-in path as the server for next=%j',
    (next) => {
      expect(routes.signIn(next)).toBe(signInPath(next));
    },
  );

  it('uses the server paths of the sign-in and claim pages', () => {
    expect(routes.signIn()).toBe(SIGN_IN_PATH);
    expect(routes.claim()).toBe(CLAIM_PATH);
  });

  it('builds the onboarding variants of the Connect Moxfield page', () => {
    expect(routes.setup()).toBe('/setup');
    for (const welcome of WELCOME_REASONS)
      expect(routes.setup({ welcome })).toBe(`/setup?welcome=${welcome}`);
  });

  it('builds the account and admin pages', () => {
    expect(routes.account()).toBe('/account');
    expect(routes.admin()).toBe('/admin');
  });
});

/** Every page of a deck, built with `deck` (the same calls for both scopes). */
function everyDeckPage(deck: DeckRoutes): string[] {
  return [
    deck.overview(),
    deck.history(),
    deck.history({ tag: 'pre ban' }),
    deck.version(3),
    deck.version(3, 'changes'),
    deck.version(3, 'deck'),
    deck.version(3, 'primer', 'primer'),
    deck.restore(3),
    deck.restore(3, 'primer'),
    deck.restoreText(3),
    deck.compare(),
    deck.compare({ from: 'v1', to: 'head', hash: 'primer' }),
    deck.compare({ from: 'empty', to: 'working' }),
    deck.cards(),
    deck.cards({ q: 'Dress Down' }),
    deck.card('dress down'),
    deck.card('dress down', { all: true }),
  ];
}

describe('deck routes', () => {
  it('builds the owner pages under /decks/<deckId>, exactly as before share links existed', () => {
    expect(everyDeckPage(ownerDeckRoutes('d1'))).toEqual([
      '/decks/d1',
      '/decks/d1/history',
      '/decks/d1/history?tag=pre+ban',
      '/decks/d1/versions/3',
      '/decks/d1/versions/3',
      '/decks/d1/versions/3?tab=deck',
      '/decks/d1/versions/3?tab=primer#primer',
      '/decks/d1/versions/3/restore',
      '/decks/d1/versions/3/restore#restore-primer',
      '/decks/d1/versions/3/restore.txt',
      '/decks/d1/compare',
      '/decks/d1/compare?from=v1&to=head#primer',
      '/decks/d1/compare?from=empty&to=working',
      '/decks/d1/cards',
      '/decks/d1/cards?q=Dress+Down',
      '/decks/d1/cards/dress%20down',
      '/decks/d1/cards/dress%20down?all=1',
    ]);
    expect(ownerDeckRoutes('d1').overview()).toBe(routes.deck('d1'));
  });

  it('builds the same pages under /s/<token> for a share link', () => {
    const token = `gmv_${'A'.repeat(43)}`;
    const owner = everyDeckPage(ownerDeckRoutes('d1'));
    const shared = everyDeckPage(sharedDeckRoutes(token));
    expect(shared).toEqual(owner.map((path) => path.replace('/decks/d1', `/s/${token}`)));
  });

  it('starts the shared pages at the server’s share link path', () => {
    const token = 'gmv_x-Y_z';
    expect(sharedDeckRoutes(token).overview()).toBe(sharedDeckPath(token));
    expect(sharedDeckRoutes(token).history().startsWith(`${SHARED_DECK_PATH}/`)).toBe(true);
  });

  it('encodes the deck id and the token as single path segments', () => {
    expect(ownerDeckRoutes('a/b?c').history()).toBe('/decks/a%2Fb%3Fc/history');
    expect(sharedDeckRoutes('x/../y').cards()).toBe('/s/x%2F..%2Fy/cards');
  });

  it('keeps the scope it was built from, so components can pass it on', () => {
    const scope = { kind: 'shared', token: 'gmv_x' } as const;
    expect(deckRoutes(scope).scope).toBe(scope);
    expect(ownerDeckRoutes('d1').scope).toEqual({ kind: 'owner', deckId: 'd1' });
  });

  it('greets a deck just sent from the browser, relinked, or both', () => {
    expect(routes.deck('d1', { captured: true })).toBe('/decks/d1?captured=1');
    expect(routes.deck('d1', { relinked: true })).toBe('/decks/d1?relinked=1');
    expect(routes.deck('d1', { captured: true, relinked: true })).toBe('/decks/d1?captured=1&relinked=1');
    expect(routes.deck('d1', { captured: false, relinked: false })).toBe('/decks/d1');
  });

  it('builds the owner-only share page', () => {
    expect(routes.deckShare('d1')).toBe('/decks/d1/share');
  });
});

describe('form submission routes', () => {
  it('puts the fields into the query, as a browser submits a GET form', () => {
    const fields: [string, FormDataEntryValue][] = [
      ['from', 'v1'],
      ['to', 'working'],
      ['q', 'Dress Down & co'],
    ];
    expect(formSubmissionRoute(ownerDeckRoutes('d1').compare(), fields)).toBe(
      '/decks/d1/compare?from=v1&to=working&q=Dress+Down+%26+co',
    );
  });

  it('keeps empty and repeated fields, and leaves out files', () => {
    const file = new File(['x'], 'x.txt');
    expect(
      formSubmissionRoute(ownerDeckRoutes('d1').cards(), [
        ['q', ''],
        ['tag', 'a'],
        ['tag', 'b'],
        ['upload', file],
      ]),
    ).toBe('/decks/d1/cards?q=&tag=a&tag=b');
  });

  it('replaces the query and fragment of the action, and adds none without fields', () => {
    const action = ownerDeckRoutes('d1').compare({ from: 'v1', to: 'v2', hash: 'primer' });
    expect(formSubmissionRoute(action, [['to', 'v3']])).toBe('/decks/d1/compare?to=v3');
    expect(formSubmissionRoute(action, [])).toBe('/decks/d1/compare');
  });
});
