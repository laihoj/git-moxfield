/**
 * The `test` of the e2e specs. On top of Playwright's own fixtures, every test:
 *
 * - starts from a known environment: the mock Moxfield is back to its seeded decks in
 *   mode `ok`, and the app's in-process state is reset (`resetApp`: server fetching
 *   resumes after a block). The database is shared by all tests and both projects, so
 *   journeys track decks of their own (`./decks.ts`);
 * - stays off the internet: card previews from Scryfall's image CDN get a placeholder,
 *   any other request outside the app and the mock is aborted (and reported below);
 * - fails on browser console errors and warnings (React's hydration mismatches among
 *   them) and on uncaught page errors, from every page of its browser context, popups
 *   included. A test that provokes an error on purpose declares it with
 *   `consoleErrors.allow(pattern)`.
 */
import { expect, test as base, type ConsoleMessage } from '@playwright/test';

import { resetApp } from './app';
import { APP_URL, MOCK_MOXFIELD_URL } from './constants';
import { mockMoxfield } from './mock';

export { expect };

export interface ConsoleErrors {
  /** Expects console errors or warnings matching `pattern` in this test (e.g. a deliberate 403). */
  allow(pattern: RegExp): void;
}

interface Fixtures {
  consoleErrors: ConsoleErrors;
  freshEnvironment: undefined;
  hermeticNetwork: undefined;
}

const LOCAL_ORIGINS: ReadonlySet<string> = new Set([
  new URL(APP_URL).origin,
  new URL(MOCK_MOXFIELD_URL).origin,
]);
const SCRYFALL_IMAGES = 'https://cards.scryfall.io/';

/** A neutral card-sized image for card previews. */
const PLACEHOLDER_CARD_IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="#ccc"/></svg>';

function isLocal(url: URL): boolean {
  return LOCAL_ORIGINS.has(url.origin) || url.protocol === 'data:' || url.protocol === 'blob:';
}

function describeMessage(message: ConsoleMessage): string {
  const { url, lineNumber } = message.location();
  const where = url === '' ? '' : ` (${url}:${lineNumber})`;
  return `console.${message.type()}: ${message.text()}${where}`;
}

export const test = base.extend<Fixtures>({
  freshEnvironment: [
    async ({}, use) => {
      await mockMoxfield.reset();
      await resetApp();
      await use(undefined);
    },
    { auto: true },
  ],

  hermeticNetwork: [
    async ({ context }, use) => {
      await context.route(
        (url) => !isLocal(url),
        (route) =>
          route.request().url().startsWith(SCRYFALL_IMAGES)
            ? route.fulfill({ status: 200, contentType: 'image/svg+xml', body: PLACEHOLDER_CARD_IMAGE })
            : route.abort('blockedbyclient'),
      );
      await use(undefined);
    },
    { auto: true },
  ],

  consoleErrors: [
    async ({ context }, use) => {
      const allowed: RegExp[] = [];
      const problems: string[] = [];
      const report = (problem: string): void => {
        if (!allowed.some((pattern) => pattern.test(problem))) problems.push(problem);
      };
      context.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') report(describeMessage(message));
      });
      context.on('weberror', (webError) => {
        const error = webError.error();
        report(`Uncaught ${error.name}: ${error.message}`);
      });
      await use({
        allow: (pattern) => {
          allowed.push(pattern);
        },
      });
      expect(problems, 'Browser console errors, warnings and uncaught errors').toEqual([]);
    },
    { auto: true },
  ],
});
