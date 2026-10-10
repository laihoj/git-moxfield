/**
 * `GET /s/{token}/versions/{n}/restore.txt` (ADR 0007): a shared deck's restore download,
 * through the real access layer on an in-memory database. Viewers need no session; the
 * file equals the owner's; every failure is the same private 404; nothing is cached or
 * indexed, and the token never reaches the logs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { restoreText } from '@/app/restore-download';
import type * as DbModule from '@/server/db/client';
import type * as SourcesModule from '@/server/sources';
import { appRequest } from '@tests/support/routes';
import { createServiceHarness, defined, type ServiceHarness } from '@tests/support/services';
import { APP_URL, sharedHistory, tokenOfShareUrl, type SharedHistory } from '@tests/support/sharing';

const state = vi.hoisted(() => ({
  harness: undefined as ServiceHarness | undefined,
  logs: [] as { level: string; message: string; context: Record<string, unknown> | undefined }[],
}));

function harness(): ServiceHarness {
  if (state.harness === undefined) throw new Error('No harness for this test');
  return state.harness;
}

vi.mock('@/server/db/client', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  getDb: () => harness().db,
}));
vi.mock('@/server/sources', async (importOriginal) => ({
  ...(await importOriginal<typeof SourcesModule>()),
  getDeckSourceRegistry: () => harness().sources,
}));
vi.mock('@/server/logger', () => ({
  createLogger: () => {
    const log =
      (level: string) =>
      (message: string, context?: Record<string, unknown>): void => {
        state.logs.push({ level, message, context });
      };
    return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
  },
}));

const { GET } = await import('@/app/s/[token]/versions/[sequence]/restore.txt/route');

let history: SharedHistory;
let token: string;
let linkId: string;

beforeEach(async () => {
  state.harness = createServiceHarness();
  state.logs.length = 0;
  history = await sharedHistory(harness());
  const created = await history.shareLinks.createShareLink(
    history.deckId,
    { label: 'For Pekka', includeNotes: false },
    APP_URL,
  );
  token = tokenOfShareUrl(created.url);
  linkId = created.link.id;
});

afterEach(() => {
  state.harness = undefined;
});

function download(shareToken: string, sequence: string): Promise<Response> {
  return GET(appRequest(`/s/${shareToken}/versions/${sequence}/restore.txt`), {
    params: Promise.resolve({ token: shareToken, sequence }),
  });
}

function expectPrivate(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
}

describe('GET /s/{token}/versions/{n}/restore.txt', () => {
  it('downloads the owner’s file, for a deck of the viewer’s own, without any session', async () => {
    const response = await download(token, 'v1');
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="blue-farm-v1-restore.txt"',
    );
    const owners = defined(await history.services.restoreExport(history.deckId, 1));
    const [, ...ownersLaterSteps] = owners.export.instructions;
    const text = await response.text();
    // The owner's file names the deck as Moxfield has it now; viewers see the committed
    // name. Their first step opens a deck of their own: they never get the owner's.
    expect(text).toBe(
      restoreText({
        ...owners,
        deck: { name: 'Blue Farm' },
        export: {
          ...owners.export,
          instructions: [
            'Open a deck of your own on Moxfield (or create one) and reload its page, so you edit its latest state.',
            ...ownersLaterSteps,
          ],
        },
      }),
    );
    expect(text).not.toContain(owners.deck.externalId);
    expect(text).not.toContain(owners.deck.url);
    expect(response.headers.has('set-cookie')).toBe(false);
  });

  it('answers every failure with the same private 404', async () => {
    const failures = [
      await download(token, '3'),
      await download(token, 'latest'),
      await download('gmv_' + 'A'.repeat(43), '1'),
      await download('not-a-token', '1'),
      await download(token.replace('gmv_', 'gms_'), '1'),
    ];
    await history.shareLinks.revokeShareLink(history.deckId, linkId);
    failures.push(await download(token, '1'));

    for (const response of failures) {
      expect(response.status).toBe(404);
      expectPrivate(response);
      expect(await response.text()).toBe('Not found.\n');
    }
  });

  it('stops working when the deck is untracked', async () => {
    expect((await download(token, '2')).status).toBe(200);
    await history.services.untrackDeck(history.deckId);
    expect((await download(token, '2')).status).toBe(404);
  });

  it('never logs the token, also when something goes wrong', async () => {
    // Recording the view fails: logged, and the download still works.
    harness().db.$client.exec(
      "CREATE TRIGGER refuse_views BEFORE UPDATE ON share_links BEGIN SELECT RAISE(ABORT, 'no writes'); END",
    );
    expect((await download(token, '1')).status).toBe(200);
    expect((await download(token, '9')).status).toBe(404);
    const warning = state.logs.find((entry) => entry.message === 'Could not record a share link view');
    expect(warning).toMatchObject({ level: 'warn', context: { linkId } });
    expect(JSON.stringify(state.logs)).not.toContain(token);
    expect(JSON.stringify(harness().logger.entries)).not.toContain(token);
  });
});
