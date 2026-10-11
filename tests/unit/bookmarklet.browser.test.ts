/**
 * The real bookmarklet (`buildBookmarklet`) running in a real browser (Playwright's
 * Chromium, installed by `pnpm test:e2e:install`) on a Moxfield deck page: what it hands
 * over in each mode decodes, with the server's decoder, to the capture the server
 * expects. Moxfield (site and API) and git-moxfield are played by request interception;
 * nothing leaves the machine. The end-to-end suite covers the same flows against the app.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildBookmarklet, parseMoxfieldCapture } from '@/integrations/moxfield/capture';
import { decodeCapturePayload } from '@/integrations/moxfield/capture-codec';
import { CAPTURE_GZIP_TAG } from '@/integrations/moxfield/capture-codec-protocol';
import {
  CAPTURE_FORM_FIELD,
  CAPTURE_FORM_PATH,
  CAPTURE_FORM_TOKEN_FIELD,
  CAPTURE_PAGE_PATH,
  DONE,
  PAYLOAD,
  READY,
} from '@/integrations/moxfield/capture-protocol';
import { v1Primer, v3Deck } from '@/integrations/moxfield/test-fixtures';
import { bookmarkletSource } from '@tests/support/bookmarklet';
import { setUpChromium } from '@tests/support/browser';

const BROWSER_TIMEOUT_MS = 60_000;

const SITE = 'https://moxfield.com';
const API = 'https://api2.moxfield.com';
/** Never contacted: every request to it is intercepted. */
const APP = 'http://localhost:3999';
const DECK_PAGE = `${SITE}/decks/FixtureDeckId_00000001`;
const KEY = `gmk_${'K'.repeat(43)}`;

const EXPECTED = { deck: v3Deck(), primer: v1Primer() };

/** Stands in for git-moxfield's capture page: announces READY, then keeps the PAYLOAD. */
const CAPTURE_PAGE_HTML = `<!doctype html><title>Capture</title><script>
const n = new URLSearchParams(location.hash.slice(1)).get('n');
window.addEventListener('message', (event) => {
  if (event.origin !== ${JSON.stringify(SITE)} || !event.data) return;
  if (event.data.t !== ${JSON.stringify(PAYLOAD)}) return;
  window.received = event.data;
  window.opener.postMessage({ t: ${JSON.stringify(DONE)}, n }, ${JSON.stringify(SITE)});
});
window.opener.postMessage({ t: ${JSON.stringify(READY)}, n }, ${JSON.stringify(SITE)});
</script>`;

const browser = setUpChromium(BROWSER_TIMEOUT_MS);
let context: BrowserContext;

beforeEach(async () => {
  context = await browser().newContext();
  // Nothing reaches the network; the routes below answer for Moxfield and git-moxfield.
  // (Playwright tries the most recently registered matching route first.)
  await context.route('**/*', (route) => route.abort());
  await context.route(`${SITE}/decks/**`, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>Deck</title><body>',
    }),
  );
  await context.route(`${API}/**`, (route) => {
    const data = route.request().url().endsWith('/primer') ? v1Primer() : v3Deck();
    return route.fulfill({ json: data, headers: { 'access-control-allow-origin': SITE } });
  });
  await context.route(`${APP}${CAPTURE_PAGE_PATH}`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: CAPTURE_PAGE_HTML }),
  );
  await context.route(`${APP}${CAPTURE_FORM_PATH}`, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>Received</title>',
    }),
  );
});

afterEach(async () => {
  await context.close();
});

function sourceOf(mode: 'popup' | 'same-tab'): string {
  return bookmarkletSource(
    buildBookmarklet({ mode, appUrl: APP, apiBaseUrl: API, siteOrigin: SITE, key: KEY }),
  );
}

async function openDeckPage(options: { withoutCompressionStream?: boolean } = {}): Promise<Page> {
  const page = await context.newPage();
  if (options.withoutCompressionStream) {
    await page.addInitScript(() => Reflect.deleteProperty(globalThis, 'CompressionStream'));
  }
  await page.goto(DECK_PAGE);
  return page;
}

/** What the same-tab bookmarklet posts: its form fields. */
async function runSameTab(page: Page): Promise<URLSearchParams> {
  const [request] = await Promise.all([
    page.waitForRequest(`${APP}${CAPTURE_FORM_PATH}`),
    page.evaluate(sourceOf('same-tab')),
  ]);
  return new URLSearchParams(request.postData() ?? '');
}

/** The capture a payload carries, decoded and parsed as the server does. */
async function captureOf(payload: string | null | undefined): Promise<unknown> {
  if (typeof payload !== 'string') throw new Error('No payload was handed over');
  return parseMoxfieldCapture(await decodeCapturePayload(payload));
}

describe('the bookmarklet in Chromium', () => {
  it(
    'same-tab mode posts the key and the compressed envelope',
    async () => {
      const fields = await runSameTab(await openDeckPage());
      expect(fields.get(CAPTURE_FORM_TOKEN_FIELD)).toBe(KEY);
      const payload = fields.get(CAPTURE_FORM_FIELD);
      expect(payload?.startsWith(CAPTURE_GZIP_TAG)).toBe(true);
      expect(await captureOf(payload)).toEqual(EXPECTED);
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'same-tab mode posts plain JSON in a browser without CompressionStream',
    async () => {
      const fields = await runSameTab(await openDeckPage({ withoutCompressionStream: true }));
      const payload = fields.get(CAPTURE_FORM_FIELD);
      expect(payload?.startsWith('{')).toBe(true);
      expect(await captureOf(payload)).toEqual(EXPECTED);
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'popup mode hands the compressed envelope and the key to the capture page',
    async () => {
      const page = await openDeckPage();
      const [popup] = await Promise.all([page.waitForEvent('popup'), page.evaluate(sourceOf('popup'))]);
      await popup.waitForFunction(() => 'received' in window);
      const received = (await popup.evaluate(
        () => (window as unknown as { received: unknown }).received,
      )) as {
        json: string;
        key: string;
      };
      expect(received.key).toBe(KEY);
      expect(received.json.startsWith(CAPTURE_GZIP_TAG)).toBe(true);
      expect(await captureOf(received.json)).toEqual(EXPECTED);
      // The capture page's DONE reached the bookmarklet.
      await expect.poll(() => page.locator('[role="status"]').textContent()).toBe('git-moxfield: Sent');
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'popup mode copies the compressed envelope to the clipboard when the popup is blocked',
    async () => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: SITE });
      const page = await openDeckPage();
      await page.evaluate(() => {
        window.open = () => null;
      });
      const alert = page.waitForEvent('dialog');
      await page.evaluate(sourceOf('popup'));
      const dialog = await alert;
      expect(dialog.message()).toBe(
        `git-moxfield: the popup was blocked, so the deck data was copied to your clipboard instead. Paste it at ${APP}${CAPTURE_PAGE_PATH}?mode=paste`,
      );
      await dialog.dismiss();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied.startsWith(CAPTURE_GZIP_TAG)).toBe(true);
      expect(await captureOf(copied)).toEqual(EXPECTED);
    },
    BROWSER_TIMEOUT_MS,
  );
});
