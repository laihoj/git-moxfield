import { describe, expect, it } from 'vitest';

import {
  handoffConfirmPath,
  handoffPath,
  invitePath,
  loginLinkPath,
  safeRedirectPath,
  sharedDeckPath,
  signInPath,
} from './paths';

describe('safeRedirectPath', () => {
  it.each([
    '/',
    '/decks/abc',
    '/decks/abc/versions/3?tab=deck',
    '/decks/abc/compare?from=v1&to=working#changes',
    '/capture?mode=paste',
  ])('keeps the local path %j', (path) => {
    expect(safeRedirectPath(path)).toBe(path);
  });

  it('normalizes dot segments like the browser would', () => {
    expect(safeRedirectPath('/decks/../setup')).toBe('/setup');
    expect(safeRedirectPath('/decks/./abc?tab=deck#c')).toBe('/decks/abc?tab=deck#c');
  });

  it('keeps encoded slashes, which browsers do not decode in paths', () => {
    expect(safeRedirectPath('/%2f%2fevil.example')).toBe('/%2f%2fevil.example');
  });

  it.each([
    ['an absolute URL', 'https://evil.example/'],
    ['a protocol-relative URL', '//evil.example/'],
    ['a backslash trick', '/\\evil.example'],
    ['a backslash later on', '/decks\\..\\\\evil.example'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a relative path', 'decks/abc'],
    ['a control character', '/decks/abc\nSet-Cookie: x=1'],
    ['a tab in a protocol-relative URL', '/\t/evil.example'],
    ['an empty string', ''],
    ['overlong input', `/${'a'.repeat(5000)}`],
    ['a non-string', ['/decks']],
    ['nothing', undefined],
    // Dot segments that normalize to a protocol-relative `//host` (AUTH-2).
    ['a dot segment before //', '/.//evil.example'],
    ['a dot-dot segment before //', '/a/..//evil.example'],
    ['dot-dot above the root before //', '/..//evil.example/phish'],
    ['an encoded dot segment before //', '/%2e//evil.example'],
    ['encoded dot-dot segments before //', '/%2E%2E//evil.example'],
    ['mixed dot segments before //', '/./%2e//evil.example'],
    ['dot-dot segments climbing out before //', '/decks/../..//evil.example'],
    ['several dot-dot segments before //', '/a/b/../..//evil.example'],
    ['dot segments before /\\', '/./\\evil.example'],
  ])('falls back for %s', (_case, value) => {
    expect(safeRedirectPath(value)).toBe('/');
    expect(safeRedirectPath(value, '/setup')).toBe('/setup');
  });
});

describe('account paths', () => {
  it('builds the sign-in page path with a safe next target', () => {
    expect(signInPath()).toBe('/signin');
    expect(signInPath('/')).toBe('/signin');
    expect(signInPath('/decks/a b?tab=deck')).toBe('/signin?next=%2Fdecks%2Fa%2520b%3Ftab%3Ddeck');
    expect(signInPath('https://evil.example')).toBe('/signin');
    expect(signInPath('/.//evil.example')).toBe('/signin');
    expect(signInPath('/%2e%2e//evil.example/x')).toBe('/signin');
  });

  it('builds the hand-off paths with the same safe next target', () => {
    expect(handoffPath('/decks/abc?captured=1')).toBe('/api/auth/handoff?next=%2Fdecks%2Fabc%3Fcaptured%3D1');
    expect(handoffPath('/')).toBe('/api/auth/handoff');
    expect(handoffPath('//evil.example')).toBe('/api/auth/handoff');
    expect(handoffConfirmPath()).toBe('/signin/bookmarklet');
    expect(handoffConfirmPath('/capture?mode=paste')).toBe(
      '/signin/bookmarklet?next=%2Fcapture%3Fmode%3Dpaste',
    );
    expect(handoffConfirmPath('https://evil.example')).toBe('/signin/bookmarklet');
  });

  it('puts link tokens into the path', () => {
    expect(loginLinkPath('gml_x')).toBe('/signin/gml_x');
    expect(invitePath('gmi_x')).toBe('/invite/gmi_x');
    expect(sharedDeckPath('gmv_x')).toBe('/s/gmv_x');
  });
});
