/**
 * The `test` of the e2e specs. On top of Playwright's own fixtures, every test:
 *
 * - starts from a known environment: the mock Moxfield is back to its seeded decks in
 *   mode `ok`, and the app's in-process state is reset (`resetApp`: server fetching
 *   resumes after a block). The database is shared by all tests and both projects, so
 *   every test signs in users of its own (`./accounts.ts`), who see only their own decks;
 * - stays off the internet: card previews from Scryfall's image CDN get a placeholder,
 *   any other request outside the app and the mock is aborted (and reported below);
 * - fails on browser console errors and warnings (React's hydration mismatches among
 *   them) and on uncaught page errors, from every page of its browser contexts, popups
 *   included. A test that provokes an error on purpose declares it with
 *   `consoleErrors.allow(pattern)`.
 *
 * `newContext()` opens another browser context: a second device or browser, sharing no
 * cookies with `context` (signed out until something signs it in). It gets the project's
 * device settings, the same network isolation and the same console checks, and is closed
 * when the test ends.
 */
import {
  expect,
  test as base,
  type BrowserContext,
  type BrowserContextOptions,
  type ConsoleMessage,
} from '@playwright/test';

import { resetApp } from './app';
import { APP_URL, MOCK_MOXFIELD_URL } from './constants';
import { mockMoxfield } from './mock';

export { expect };

export interface ConsoleErrors {
  /** Expects console errors or warnings matching `pattern` in this test (e.g. a deliberate 403). */
  allow(pattern: RegExp): void;
}

/**
 * Opens a new, signed-out browser context (another device), prepared like `context`.
 * `options` override the project's device settings (e.g. `devices['Pixel 7']`).
 */
export type NewContext = (options?: BrowserContextOptions) => Promise<BrowserContext>;

interface Fixtures {
  consoleErrors: ConsoleErrors;
  newContext: NewContext;
  freshEnvironment: undefined;
  hermeticNetwork: undefined;
}

interface InternalFixtures {
  /** Collects console problems from every context of the test; fails the test on any not allowed. */
  browserProblems: BrowserProblems;
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

/** Keeps `context` off the internet: placeholder card images, everything else non-local aborted. */
async function isolateNetwork(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => !isLocal(url),
    (route) =>
      route.request().url().startsWith(SCRYFALL_IMAGES)
        ? route.fulfill({ status: 200, contentType: 'image/svg+xml', body: PLACEHOLDER_CARD_IMAGE })
        : route.abort('blockedbyclient'),
  );
}

/** Console errors, warnings and uncaught errors of the test's browser contexts. */
class BrowserProblems implements ConsoleErrors {
  readonly problems: string[] = [];
  private readonly allowed: RegExp[] = [];

  allow(pattern: RegExp): void {
    this.allowed.push(pattern);
  }

  /** Records the problems of every page of `context`, popups included. */
  watch(context: BrowserContext): void {
    context.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') this.report(describeMessage(message));
    });
    context.on('weberror', (webError) => {
      const error = webError.error();
      this.report(`Uncaught ${error.name}: ${error.message}`);
    });
  }

  private report(problem: string): void {
    if (!this.allowed.some((pattern) => pattern.test(problem))) this.problems.push(problem);
  }
}

export const test = base.extend<Fixtures & InternalFixtures>({
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
      await isolateNetwork(context);
      await use(undefined);
    },
    { auto: true },
  ],

  browserProblems: [
    async ({ context }, use) => {
      const problems = new BrowserProblems();
      problems.watch(context);
      await use(problems);
      expect(problems.problems, 'Browser console errors, warnings and uncaught errors').toEqual([]);
    },
    { auto: true },
  ],

  consoleErrors: [
    async ({ browserProblems }, use) => {
      await use(browserProblems);
    },
    { scope: 'test' },
  ],

  newContext: [
    async ({ browser, browserProblems }, use) => {
      const opened: BrowserContext[] = [];
      await use(async (options) => {
        // `browser.newContext()` applies the project's `use` options (device, base URL)
        // wherever `options` leave them out.
        const context = await browser.newContext(options);
        opened.push(context);
        browserProblems.watch(context);
        await isolateNetwork(context);
        return context;
      });
      // Closed before `browserProblems` checks what they reported.
      for (const context of opened) await context.close();
    },
    { scope: 'test' },
  ],
});
