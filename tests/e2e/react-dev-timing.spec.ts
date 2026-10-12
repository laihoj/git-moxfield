/**
 * The React development bug that the console checks of `./support/fixtures.ts` tolerate:
 * with the browser's clock ahead of the dev server's, a page whose server component threw
 * (here a dead share link) makes React's Server Components performance track throw. The
 * test moves the browser's time origin an hour ahead, so it happens on every run instead
 * of now and then.
 */
import { expect, test } from './support/fixtures';
import { expectLinkNotWorking } from './support/share';

test('a dead share link stays clean when the browser clock is ahead of the server', async ({
  page,
  consoleErrors,
}) => {
  consoleErrors.allowHttpStatus(404);
  await page.addInitScript(() => {
    const ahead = performance.timeOrigin + 60 * 60 * 1000;
    Object.defineProperty(performance, 'timeOrigin', { get: () => ahead });
  });
  const reactTimingError = page.waitForEvent('pageerror', {
    predicate: (error) => error.message.includes('cannot have a negative time stamp'),
    timeout: 10_000,
  });

  await expectLinkNotWorking(page, `/s/gmv_${'x'.repeat(43)}`);
  // React still has the bug (else delete this spec and the fixture's allowance); the
  // fixture's check at the end of the test passes all the same.
  await expect(reactTimingError).resolves.toBeDefined();
});
