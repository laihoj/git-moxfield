/**
 * `POST /api/capture/form` (the same-tab bookmarklet's target) against the real services
 * on an in-memory database: the capture token authenticates the post, the `Origin`
 * header only rules out explicit third-party origins, and the token never reaches logs.
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CAPTURE_FORM_FIELD,
  CAPTURE_FORM_TOKEN_FIELD,
  MAX_CAPTURE_BYTES,
} from '@/integrations/moxfield/capture-protocol';
import type * as ServicesModule from '@/server/services';
import type { DeckServices } from '@/server/services';
import { buildCaptureEnvelope } from '@tests/support/moxfield-deck-builder';
import { blueFarmSpec, createServiceHarness, type ServiceHarness } from '@tests/support/services';

const state = vi.hoisted(() => ({
  services: undefined as DeckServices | undefined,
  logs: [] as { level: string; message: string; context: Record<string, unknown> | undefined }[],
}));

vi.mock('@/server/services', async (importOriginal) => ({
  ...(await importOriginal<typeof ServicesModule>()),
  getServices: (): DeckServices => {
    if (state.services === undefined) throw new Error('No services for this test');
    return state.services;
  },
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

const { POST } = await import('@/app/api/capture/form/route');

const APP = 'http://localhost:3000';
const MOXFIELD = 'https://moxfield.com';

let harness: ServiceHarness;
let token: string;

beforeEach(() => {
  harness = createServiceHarness();
  state.services = harness.services;
  state.logs.length = 0;
  token = harness.services.getCaptureToken();
});

afterEach(() => {
  state.services = undefined;
});

interface PostOptions {
  /** `Origin` header, or `null` to send none. Default `'null'` (the opaque origin). */
  origin?: string | null;
  /** Form fields; default: the installation token and a Blue Farm envelope. */
  fields?: Record<string, string>;
}

function post({ origin = 'null', fields }: PostOptions = {}): Promise<Response> {
  const body = new URLSearchParams(
    fields ?? {
      [CAPTURE_FORM_TOKEN_FIELD]: token,
      [CAPTURE_FORM_FIELD]: JSON.stringify(buildCaptureEnvelope(blueFarmSpec())),
    },
  );
  const headers = new Headers({
    'content-type': 'application/x-www-form-urlencoded',
    host: new URL(APP).host,
    'sec-fetch-site': 'cross-site',
  });
  if (origin !== null) headers.set('origin', origin);
  return POST(new NextRequest(`${APP}/api/capture/form`, { method: 'POST', headers, body }));
}

async function trackedDeckCount(): Promise<number> {
  return (await harness.services.listDecks()).length;
}

describe('POST /api/capture/form', () => {
  it.each([
    ['the opaque origin (https Moxfield → http git-moxfield)', 'null'],
    ['no Origin header', null],
    ['the configured Moxfield origin', MOXFIELD],
  ])('ingests a capture with the installation token and %s', async (_case, origin) => {
    const response = await post({ origin });
    expect(response.status).toBe(303);
    const [deck] = await harness.services.listDecks();
    expect(response.headers.get('location')).toBe(`/decks/${deck?.id}?captured=1`);
    expect(deck).toMatchObject({ name: 'Blue Farm', working: { method: 'browser-capture' } });
  });

  it('ingests a large deck whose form-encoded body is well over 10 MB', async () => {
    // A huge Considering board: the envelope stays under MAX_CAPTURE_BYTES, but form
    // encoding (every quote, colon, comma and brace becomes %XX) grows it by about 1.5x.
    const considering = Array.from({ length: 11_000 }, (_, i) => `Considered Card ${i}`);
    const payload = JSON.stringify(buildCaptureEnvelope(blueFarmSpec({ considering })));
    const fields = { [CAPTURE_FORM_TOKEN_FIELD]: token, [CAPTURE_FORM_FIELD]: payload };
    expect(payload.length).toBeGreaterThan(7_000_000);
    expect(payload.length).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
    expect(new URLSearchParams(fields).toString().length).toBeGreaterThan(11 * 1024 * 1024);

    const response = await post({ fields });
    expect(response.status).toBe(303);
    const [deck] = await harness.services.listDecks();
    expect(response.headers.get('location')).toBe(`/decks/${deck?.id}?captured=1`);
  }, 60_000);

  it('rejects an explicit third-party origin before reading the body', async () => {
    const response = await post({ origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('<h1>Deck not accepted</h1>');
    expect(await trackedDeckCount()).toBe(0);
    expect(state.logs).toEqual([
      expect.objectContaining({
        level: 'warn',
        message: 'Rejected same-tab capture from an unexpected origin',
        context: expect.objectContaining({ origin: 'https://evil.example' }) as unknown,
      }),
    ]);
  });

  it.each([
    ['missing', undefined, 'missing'],
    ['empty', '', 'wrong'],
    ['wrong', 'f'.repeat(64), 'wrong'],
  ])('rejects a capture whose token is %s, without logging tokens', async (_case, sent, logged) => {
    const fields: Record<string, string> = {
      [CAPTURE_FORM_FIELD]: JSON.stringify(buildCaptureEnvelope(blueFarmSpec())),
    };
    if (sent !== undefined) fields[CAPTURE_FORM_TOKEN_FIELD] = sent;

    const response = await post({ fields });
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await response.text();
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<h1>Reinstall the bookmarklet</h1>');
    expect(html).toContain('<a href="/setup">Open Connect Moxfield</a>');
    expect(html).not.toContain(token);
    expect(await trackedDeckCount()).toBe(0);

    expect(state.logs).toEqual([
      {
        level: 'warn',
        message: 'Rejected same-tab capture without a valid capture token',
        context: { origin: 'null', secFetchSite: 'cross-site', token: logged },
      },
    ]);
    expect(JSON.stringify(state.logs)).not.toContain(token);
  });

  it('checks the token before looking at the payload', async () => {
    const response = await post({ fields: { [CAPTURE_FORM_FIELD]: 'not json' } });
    expect(response.status).toBe(403);
  });

  it('sends unusable payloads with a valid token to the paste page', async () => {
    const response = await post({
      fields: { [CAPTURE_FORM_TOKEN_FIELD]: token, [CAPTURE_FORM_FIELD]: 'not json' },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/capture?mode=paste&error=invalid');
    expect(await trackedDeckCount()).toBe(0);
  });
});
