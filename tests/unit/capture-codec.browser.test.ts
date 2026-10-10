/**
 * The bookmarklet's encoder (`ENCODE_CAPTURE_PAYLOAD_SOURCE`) running in a real browser
 * (Playwright's Chromium, installed by `pnpm test:e2e:install`), decoded by the server's
 * decoder: the round trip every capture takes, minus the network.
 */
import { existsSync } from 'node:fs';

import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { envelopeJson, incompressibleJson, UNICODE_SAMPLE } from '@tests/support/capture-codec';

import { decodeCapturePayload } from '@/integrations/moxfield/capture-codec';
import {
  CAPTURE_GZIP_TAG,
  ENCODE_CAPTURE_PAYLOAD_SOURCE,
  MAX_ENCODED_CAPTURE_CHARS,
} from '@/integrations/moxfield/capture-codec-protocol';

const BROWSER_TIMEOUT_MS = 60_000;

/** The page global the encoder is installed as, the way the bookmarklet embeds it. */
interface EncoderWindow {
  encodeCapturePayload: (text: string) => Promise<string>;
}

let browser: Browser;

async function openPage(options: { withoutCompressionStream?: boolean } = {}): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>Moxfield deck</title>');
  if (options.withoutCompressionStream) {
    await page.evaluate(() => Reflect.deleteProperty(globalThis, 'CompressionStream'));
  }
  await page.addScriptTag({ content: `window.encodeCapturePayload = ${ENCODE_CAPTURE_PAYLOAD_SOURCE};` });
  return page;
}

async function encodeInBrowser(page: Page, text: string): Promise<string> {
  return page.evaluate((input) => (window as unknown as EncoderWindow).encodeCapturePayload(input), text);
}

beforeAll(async () => {
  if (!existsSync(chromium.executablePath())) {
    throw new Error("Playwright's Chromium is not installed: run `pnpm test:e2e:install`.");
  }
  browser = await chromium.launch();
}, BROWSER_TIMEOUT_MS);

afterAll(async () => {
  await browser.close();
});

describe('capture encoding in Chromium', () => {
  it(
    'compresses a capture envelope that the server decodes to the exact text',
    async () => {
      const page = await openPage();
      for (const text of [envelopeJson(), UNICODE_SAMPLE, '']) {
        const encoded = await encodeInBrowser(page, text);
        expect(encoded.startsWith(CAPTURE_GZIP_TAG)).toBe(true);
        expect(encoded.slice(CAPTURE_GZIP_TAG.length)).toMatch(/^[A-Za-z0-9_-]*$/);
        await expect(decodeCapturePayload(encoded)).resolves.toBe(text);
      }
      const envelope = envelopeJson();
      expect((await encodeInBrowser(page, envelope)).length).toBeLessThan(envelope.length / 2);
      await page.close();
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'encodes megabytes of gzip without overflowing the stack',
    async () => {
      const page = await openPage();
      // Noise that gzip barely shrinks: about 1.3 MB of gzip for btoa, in ~50 chunks.
      const text = incompressibleJson(1_500_000);
      const encoded = await encodeInBrowser(page, text);
      expect(encoded.length).toBeGreaterThan(1_600_000);
      expect(encoded.length).toBeLessThan(MAX_ENCODED_CAPTURE_CHARS);
      await expect(decodeCapturePayload(encoded)).resolves.toBe(text);
      await page.close();
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'sends plain text when the browser has no CompressionStream',
    async () => {
      const page = await openPage({ withoutCompressionStream: true });
      expect(
        await page.evaluate(() => typeof (globalThis as Record<string, unknown>).CompressionStream),
      ).toBe('undefined');
      const text = envelopeJson();
      const encoded = await encodeInBrowser(page, text);
      expect(encoded).toBe(text);
      await expect(decodeCapturePayload(encoded)).resolves.toBe(text);
      await page.close();
    },
    BROWSER_TIMEOUT_MS,
  );
});
