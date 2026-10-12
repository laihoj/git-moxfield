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
 *   `consoleErrors.allow(pattern)`, or with `consoleErrors.allowHttpStatus(…)` for the
 *   report of an error status (a deliberate 403 or 404).
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
  /** Expects console errors or warnings matching `pattern` in this test. */
  allow(pattern: RegExp): void;
  /**
   * Expects the browser's console report of a failed request for each of the HTTP `statuses`
   * (`Failed to load resource: the server responded with a status of 404 (Not Found)`):
   * every page or request the test provokes to be refused on purpose.
   */
  allowHttpStatus(...statuses: number[]): void;
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

/**
 * A React development-build bug, not the app's: after a server component throws (every
 * `notFound()` page, such as a dead share link), React draws its Server Components
 * performance track and passes `performance.measure` a negative end time when the dev
 * server's clock is behind the browser's (a `next dev` that lived through a sleep is
 * enough), so the measure throws a moment after the page has rendered. Production builds
 * have no such track. `tests/e2e/react-dev-timing.spec.ts` provokes it; when that spec
 * fails because the error no longer happens, React is fixed: delete both.
 */
const REACT_DEV_TIMING_ERROR =
  /^Uncaught TypeError: Failed to execute 'measure' on 'Performance': '[^']*' cannot have a negative time stamp\.$/;

/** Console errors, warnings and uncaught errors of the test's browser contexts. */
class BrowserProblems implements ConsoleErrors {
  readonly problems: string[] = [];
  private readonly allowed: RegExp[] = [REACT_DEV_TIMING_ERROR];

  allow(pattern: RegExp): void {
    this.allowed.push(pattern);
  }

  allowHttpStatus(...statuses: number[]): void {
    this.allow(
      new RegExp(
        `Failed to load resource: the server responded with a status of (?:${statuses.join('|')})\\b`,
      ),
    );
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
