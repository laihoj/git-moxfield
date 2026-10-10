import { describe, expect, it } from 'vitest';

import { CLAIM_PATH, SIGN_IN_PATH, signInPath } from '@/server/auth/paths';

import { routes, WELCOME_REASONS } from './routes';

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
