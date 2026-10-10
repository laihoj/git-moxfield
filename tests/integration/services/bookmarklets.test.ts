import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CAPTURE_TOKEN_PATTERN } from '@/integrations/moxfield/capture-protocol';
import { openDatabase, type Db } from '@/server/db/client';
import { CAPTURE_TOKEN_SETTING, createServices, type DeckServices } from '@/server/services';
import { countRows } from '@tests/support/db';
import { createServiceHarness, recordingLogger } from '@tests/support/services';

const APP_URL = 'http://192.168.1.20:3000';

function source(bookmarklet: string): string {
  expect(bookmarklet.startsWith('javascript:')).toBe(true);
  return decodeURIComponent(bookmarklet.slice('javascript:'.length));
}

describe('deck services: capture token and bookmarklets', () => {
  describe('getCaptureToken', () => {
    it('creates a random 256-bit token once and returns it from then on', () => {
      const harness = createServiceHarness();
      const token = harness.services.getCaptureToken();

      expect(token).toMatch(CAPTURE_TOKEN_PATTERN);
      expect(harness.services.getCaptureToken()).toBe(token);
      expect(harness.sibling().getCaptureToken()).toBe(token);
      expect(harness.repos.settings.get(CAPTURE_TOKEN_SETTING)).toBe(token);
      expect(countRows(harness.db, 'app_settings')).toBe(1);

      // Another installation gets another token.
      expect(createServiceHarness().services.getCaptureToken()).not.toBe(token);
    });

    it('refuses a malformed stored token without revealing it', () => {
      const harness = createServiceHarness();
      harness.repos.settings.set(CAPTURE_TOKEN_SETTING, 'hand-edited-secret');
      let message = '';
      try {
        harness.services.getCaptureToken();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/capture token is malformed/);
      expect(message).not.toContain('hand-edited-secret');
      expect(() => harness.services.getBookmarklets(APP_URL)).toThrow(/capture token is malformed/);
    });

    describe('across restarts', () => {
      let dir: string | undefined;
      const open: Db[] = [];

      afterEach(() => {
        for (const db of open.splice(0)) db.$client.close();
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
        dir = undefined;
      });

      /** Services over a database file, as a freshly started app process builds them. */
      function start(harness = createServiceHarness()): DeckServices {
        dir ??= mkdtempSync(join(tmpdir(), 'git-moxfield-token-'));
        const db = openDatabase(join(dir, 'app.db'));
        open.push(db);
        return createServices({
          db,
          sources: harness.sources,
          config: harness.config,
          logger: recordingLogger(),
        });
      }

      it('keeps the token, so installed bookmarklets keep working', () => {
        const before = start();
        const token = before.getCaptureToken();
        const bookmarklets = before.getBookmarklets(APP_URL);

        for (const db of open.splice(0)) db.$client.close();
        const after = start();
        expect(after.getCaptureToken()).toBe(token);
        expect(after.getBookmarklets(APP_URL)).toEqual(bookmarklets);
      });
    });
  });

  describe('getBookmarklets', () => {
    it('builds both bookmarklets for the app URL and the configured Moxfield', () => {
      const harness = createServiceHarness({
        env: {
          MOXFIELD_SITE_ORIGIN: 'http://localhost:4010',
          CAPTURE_ALLOWED_ORIGINS: 'http://localhost:4010',
        },
      });
      const { popup, sameTab } = harness.services.getBookmarklets(`${APP_URL}/`);

      for (const bookmarklet of [popup, sameTab]) {
        const body = source(bookmarklet);
        expect(body).toContain(`"app":"${APP_URL}"`);
        expect(body).toContain(`"api":"${harness.api.apiBaseUrl}"`);
        expect(body).toContain('"site":"http://localhost:4010"');
      }
      expect(source(popup)).toContain('window.open(');
      expect(source(sameTab)).toContain('"formPath":"/api/capture/form"');
    });

    it('puts the capture token into the same-tab bookmarklet only, creating it once', () => {
      const harness = createServiceHarness();
      const first = harness.services.getBookmarklets(APP_URL);
      const token = harness.services.getCaptureToken();

      expect(source(first.sameTab)).toContain(`"token":"${token}"`);
      expect(first.popup).not.toContain(token);
      expect(harness.services.getBookmarklets(APP_URL)).toEqual(first);
      expect(countRows(harness.db, 'app_settings')).toBe(1);
    });

    it('keeps the setup info free of the token', () => {
      const harness = createServiceHarness();
      const token = harness.services.getCaptureToken();
      expect(JSON.stringify(harness.services.getSetupInfo())).not.toContain(token);
    });

    it('rejects an app URL that is not an absolute http(s) URL', () => {
      const { services } = createServiceHarness();
      expect(() => services.getBookmarklets('localhost:3000')).toThrow(TypeError);
      expect(() => services.getBookmarklets('ftp://example.test')).toThrow(TypeError);
    });
  });
});
