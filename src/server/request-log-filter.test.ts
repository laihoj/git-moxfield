import { describe, expect, it } from 'vitest';

import { invitePath, loginLinkPath, sharedDeckPath, signInPath } from './auth/paths';
import { generateToken } from './auth/tokens';
import { isUnloggedRequest } from './request-log-filter';

const share = generateToken('share');
const login = generateToken('login');
const invite = generateToken('invite');

describe('isUnloggedRequest', () => {
  it.each([
    ['a share link', sharedDeckPath(share)],
    ['a share link page', `${sharedDeckPath(share)}/history?tag=tournament`],
    ['a share link navigation', `${sharedDeckPath(share)}/versions/2?tab=deck&_rsc=1x2y3`],
    ['a share link download', `${sharedDeckPath(share)}/versions/1/restore.txt`],
    ['a mangled share link', '/s/gmv_cut-off'],
    ['a share link without its prefix', `/s/${share.slice('gmv_'.length)}`],
    ['a device or recovery link', loginLinkPath(login)],
    ['a sign-in link navigation', `${loginLinkPath(login)}?_rsc=abc`],
    ['a mangled sign-in link', '/signin/gml_abc'],
    ['an invite', invitePath(invite)],
    ['a mangled invite', '/invite/whatever'],
    ['an absolute-form request target', `http://localhost:3000${sharedDeckPath(share)}`],
    ['a token elsewhere in the URL', `/signin?next=${encodeURIComponent(sharedDeckPath(share))}`],
    ['a token in an unknown path', `/decks/${share}`],
  ])('keeps %s out of the request log', (_what, url) => {
    expect(isUnloggedRequest(url)).toBe(true);
  });

  it.each([
    '/',
    '/decks/7f3c2a8e-0d9b-4f61-9a43-5c1d2e7b8f90/versions/3?tab=deck',
    '/decks/7f3c2a8e-0d9b-4f61-9a43-5c1d2e7b8f90/share',
    '/decks/7f3c2a8e-0d9b-4f61-9a43-5c1d2e7b8f90/cards/sol%20ring',
    '/signin',
    signInPath('/decks/abc'),
    '/signin/bookmarklet',
    '/signin/bookmarklet?next=%2Fdecks%2Fabc',
    '/s',
    '/setup',
    '/account',
    '/api/capture',
    '/api/auth/handoff',
  ])('logs %j', (url) => {
    expect(isUnloggedRequest(url)).toBe(false);
  });
});
