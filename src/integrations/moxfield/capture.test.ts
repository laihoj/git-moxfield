import { createContext, runInContext, Script } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { DeckSourceError } from '../deck-source';

import { buildBookmarklet, parseMoxfieldCapture, type BookmarkletOptions } from './capture';
import {
  BOOKMARKLET_KEY_PATTERN,
  CAPTURE_ENVELOPE_KIND,
  CAPTURE_FORM_FIELD,
  CAPTURE_FORM_TOKEN_FIELD,
  CAPTURE_PROTOCOL_VERSION,
  DONE,
  ERROR,
  isCaptureEnvelope,
  MAX_CAPTURE_BYTES,
  PAYLOAD,
  READY,
} from './capture-protocol';
import { v1Primer, v2Deck, v3Deck } from './test-fixtures';

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: CAPTURE_ENVELOPE_KIND,
    version: CAPTURE_PROTOCOL_VERSION,
    source: 'moxfield',
    pageUrl: 'https://moxfield.com/decks/FixtureDeckId_00000001',
    capturedAt: '2026-10-09T12:00:00.000Z',
    deck: v3Deck(),
    primer: v1Primer(),
    primerError: null,
    ...overrides,
  };
}

function expectSchemaError(fn: () => unknown, fragment: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DeckSourceError);
  expect((caught as DeckSourceError).code).toBe('schema');
  expect((caught as DeckSourceError).message).toContain(fragment);
}

describe('parseMoxfieldCapture', () => {
  it('accepts a bookmarklet envelope, as object or JSON string', () => {
    const expected = { deck: v3Deck(), primer: v1Primer() };
    expect(parseMoxfieldCapture(envelope())).toEqual(expected);
    expect(parseMoxfieldCapture(JSON.stringify(envelope()))).toEqual(expected);
  });

  it('carries the primer error of an envelope', () => {
    expect(
      parseMoxfieldCapture(envelope({ primer: null, primerError: 'Primer not captured: HTTP 500' })),
    ).toEqual({
      deck: v3Deck(),
      primer: null,
      primerError: 'Primer not captured: HTTP 500',
    });
  });

  it('rejects envelopes of another protocol version or source', () => {
    expectSchemaError(() => parseMoxfieldCapture(envelope({ version: 3 })), 'unsupported protocol version');
    // Bookmarklets made before accounts: their envelopes are version 1.
    expectSchemaError(() => parseMoxfieldCapture(envelope({ version: 1 })), 'the bookmarklet is out of date');
    expectSchemaError(
      () => parseMoxfieldCapture(envelope({ source: 'archidekt' })),
      'does not come from Moxfield',
    );
  });

  it('accepts { deck, primer } with nested JSON strings from paste fields', () => {
    expect(
      parseMoxfieldCapture({ deck: JSON.stringify(v3Deck()), primer: JSON.stringify(v1Primer()) }),
    ).toEqual({ deck: v3Deck(), primer: v1Primer() });
    expect(parseMoxfieldCapture({ deck: v3Deck(), primer: '   ' })).toEqual({ deck: v3Deck(), primer: null });
    expect(parseMoxfieldCapture({ deck: v3Deck(), primer: '{oops' })).toEqual({
      deck: v3Deck(),
      primer: null,
      primerError: expect.stringContaining('The primer is not valid JSON') as unknown,
    });
  });

  it('accepts a bare v3 or v2 deck (manual paste) with an unknown primer', () => {
    expect(parseMoxfieldCapture(v3Deck())).toEqual({ deck: v3Deck(), primer: null });
    expect(parseMoxfieldCapture(`\n  ${JSON.stringify(v2Deck())}\n`)).toEqual({
      deck: v2Deck(),
      primer: null,
    });
  });

  it('uses a separately pasted primer', () => {
    expect(parseMoxfieldCapture(JSON.stringify(v3Deck()), JSON.stringify(v1Primer()))).toEqual({
      deck: v3Deck(),
      primer: v1Primer(),
    });
    expect(parseMoxfieldCapture(v3Deck(), '')).toEqual({ deck: v3Deck(), primer: null });
    expect(parseMoxfieldCapture(envelope({ primer: null, primerError: 'x' }), v1Primer())).toEqual({
      deck: v3Deck(),
      primer: v1Primer(),
    });
  });

  it('explains a pasted primer in place of the deck', () => {
    expectSchemaError(() => parseMoxfieldCapture(v1Primer()), 'looks like the primer JSON');
  });

  it.each([
    ['', 'Nothing was pasted'],
    ['   ', 'Nothing was pasted'],
    ['not json', 'not valid JSON'],
    ['[]', 'not a Moxfield deck'],
    ['42', 'not a Moxfield deck'],
    [null, 'not a Moxfield deck'],
    [{ title: 'Not Found', status: 404 }, 'publicId:'],
    [{ ...v3Deck(), publicId: 'bad id!' }, 'publicId: Invalid input: expected a Moxfield deck id'],
    [{ deck: 'not json' }, 'The deck JSON is not valid JSON'],
    [{ deck: null }, 'not a usable Moxfield deck'],
  ])('rejects %j', (input, fragment) => {
    expectSchemaError(() => parseMoxfieldCapture(input), fragment);
  });

  it('rejects oversized input before parsing it', () => {
    expectSchemaError(() => parseMoxfieldCapture(' '.repeat(MAX_CAPTURE_BYTES) + '{}'), 'too large');
  });
});

// ---------------------------------------------------------------------------------
// Bookmarklet: executed for real in a node:vm sandbox with fake browser globals.
// ---------------------------------------------------------------------------------

const APP_URL = 'http://localhost:3000';
const DECK_PAGE = 'https://moxfield.com/decks/FixtureDeckId_00000001/primer?tab=x#top';
const NONCE = 'ab'.repeat(16);
const KEY = 'gmk_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';

function bookmarkletBody(url: string): string {
  expect(url.startsWith('javascript:')).toBe(true);
  return decodeURIComponent(url.slice('javascript:'.length));
}

class FakeElement {
  readonly style: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  textContent = '';
  removed = false;
  submitted = false;
  method = '';
  action = '';
  target = '';
  acceptCharset = '';
  name = '';
  value = '';
  type = '';

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  remove(): void {
    this.removed = true;
  }

  submit(): void {
    this.submitted = true;
  }
}

interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

interface PostedMessage {
  data: Record<string, unknown>;
  targetOrigin: string;
}

interface FakeMessageEvent {
  source: unknown;
  origin: string;
  data: unknown;
}

class FakeClipboardItem {
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}

function browser(
  options: {
    href?: string;
    popupBlocked?: boolean;
    clipboardWrite?: 'ok' | 'reject';
    respond?: (url: string) => FakeResponse;
  } = {},
) {
  const url = new URL(options.href ?? DECK_PAGE);
  const fetched: string[] = [];
  const opened: { url: string; target: string }[] = [];
  const alerts: string[] = [];
  const events: string[] = [];
  const listeners = new Set<(event: FakeMessageEvent) => void>();
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const created: FakeElement[] = [];
  const posted: PostedMessage[] = [];
  const clipboard = { items: [] as FakeClipboardItem[], texts: [] as string[] };
  const popup = {
    postMessage(data: Record<string, unknown>, targetOrigin: string): void {
      posted.push({ data, targetOrigin });
    },
  };
  const body = new FakeElement('body');
  const respond =
    options.respond ??
    ((requestUrl: string): FakeResponse => {
      const data: unknown = requestUrl.includes('/primer') ? v1Primer() : v3Deck();
      return { ok: true, status: 200, json: () => Promise.resolve(data) };
    });

  const context = createContext({
    location: { href: url.href, origin: url.origin, pathname: url.pathname },
    document: {
      body,
      createElement(tag: string): FakeElement {
        const element = new FakeElement(tag);
        created.push(element);
        return element;
      },
    },
    window: {
      open(target: string, name: string): unknown {
        events.push('open');
        opened.push({ url: target, target: name });
        return options.popupBlocked === true ? null : popup;
      },
      addEventListener(type: string, listener: (event: FakeMessageEvent) => void): void {
        if (type === 'message') listeners.add(listener);
      },
      removeEventListener(type: string, listener: (event: FakeMessageEvent) => void): void {
        if (type === 'message') listeners.delete(listener);
      },
    },
    fetch(requestUrl: string): Promise<FakeResponse> {
      events.push('fetch');
      fetched.push(requestUrl);
      return Promise.resolve(respond(requestUrl));
    },
    crypto: {
      getRandomValues(array: Uint8Array): Uint8Array {
        array.fill(0xab);
        return array;
      },
    },
    navigator: {
      clipboard: {
        write(items: FakeClipboardItem[]): Promise<void> {
          clipboard.items.push(...items);
          return options.clipboardWrite === 'reject'
            ? Promise.reject(new Error('ClipboardItem not supported'))
            : Promise.resolve();
        },
        writeText(text: string): Promise<void> {
          clipboard.texts.push(text);
          return Promise.resolve();
        },
      },
    },
    ClipboardItem: FakeClipboardItem,
    Blob,
    alert(message: string): void {
      alerts.push(message);
    },
    setTimeout(fn: () => void, ms: number): number {
      timers.push({ fn, ms, cleared: false });
      return timers.length;
    },
    clearTimeout(id: number): void {
      const timer = timers[id - 1];
      if (timer) timer.cleared = true;
    },
  });

  return {
    run(bookmarklet: string): void {
      runInContext(bookmarkletBody(bookmarklet), context);
    },
    dispatch(event: FakeMessageEvent): void {
      for (const listener of [...listeners]) listener(event);
    },
    fireTimers(ms: number): void {
      for (const timer of timers) if (!timer.cleared && timer.ms === ms) timer.fn();
    },
    popup,
    body,
    fetched,
    opened,
    alerts,
    events,
    listeners,
    created,
    posted,
    clipboard,
    status: (): string => body.children[0]?.textContent ?? '',
  };
}

/** Lets all pending promise callbacks (in every realm) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

const popupBookmarklet = buildBookmarklet({ appUrl: `${APP_URL}/`, mode: 'popup', key: KEY });
const sameTabBookmarklet = buildBookmarklet({ appUrl: APP_URL, mode: 'same-tab', key: KEY });

describe('buildBookmarklet', () => {
  it.each([
    ['popup', popupBookmarklet],
    ['same-tab', sameTabBookmarklet],
  ])('%s mode decodes to valid, self-contained JavaScript', (_mode, bookmarklet) => {
    const body = bookmarkletBody(bookmarklet);
    expect(() => new Script(body)).not.toThrow();
    expect(body).toContain('"app":"http://localhost:3000"');
    expect(body).toContain('"site":"https://moxfield.com"');
    expect(body).toContain('"api":"https://api2.moxfield.com"');
    expect(body).not.toMatch(/['"]\*['"]/);
    expect(body).not.toMatch(/<script|import\(|\beval\b|innerHTML/);
    expect(bookmarklet.length).toBeLessThan(8000);
  });

  it('embeds overridden origins and keeps an app base path', () => {
    const body = bookmarkletBody(
      buildBookmarklet({
        appUrl: 'https://tools.example/git-moxfield/?q=1#x',
        mode: 'popup',
        apiBaseUrl: 'http://localhost:4010/api/',
        siteOrigin: 'http://localhost:4010/ignored/path',
        key: KEY,
      }),
    );
    expect(body).toContain('"app":"https://tools.example/git-moxfield"');
    expect(body).toContain('"appOrigin":"https://tools.example"');
    expect(body).toContain('"api":"http://localhost:4010/api"');
    expect(body).toContain('"site":"http://localhost:4010"');
  });

  it('rejects unusable URLs', () => {
    expect(() => buildBookmarklet({ appUrl: 'localhost:3000', mode: 'popup', key: KEY })).toThrow(TypeError);
    expect(() => buildBookmarklet({ appUrl: 'javascript:alert(1)', mode: 'popup', key: KEY })).toThrow(
      TypeError,
    );
    expect(() => buildBookmarklet({ appUrl: APP_URL, mode: 'popup', siteOrigin: 'nope', key: KEY })).toThrow(
      TypeError,
    );
  });

  it('embeds the bookmarklet key in both modes, each with only its own configuration', () => {
    expect(BOOKMARKLET_KEY_PATTERN.test(KEY)).toBe(true);
    const sameTab = bookmarkletBody(sameTabBookmarklet);
    expect(sameTab).toContain(`"key":"${KEY}"`);
    expect(sameTab).toContain(`"tokenField":"${CAPTURE_FORM_TOKEN_FIELD}"`);
    expect(sameTab).not.toContain('"capturePath"');
    const popup = bookmarkletBody(popupBookmarklet);
    expect(popup).toContain(`"key":"${KEY}"`);
    expect(popup).not.toContain('"formPath"');
    expect(popup).not.toContain('"tokenField"');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too short', 'gmk_abc123'],
    ['a session token', `gms_${KEY.slice(4)}`],
    ['an installation capture token from before accounts', '0123456789abcdef'.repeat(4)],
    ['with a quote', `${KEY.slice(0, -1)}"`],
  ])('refuses a key that is %s, in both modes', (_case, key) => {
    for (const mode of ['popup', 'same-tab']) {
      const options = { appUrl: APP_URL, mode, key } as unknown as BookmarkletOptions;
      expect(() => buildBookmarklet(options)).toThrow(TypeError);
    }
  });
});

describe('bookmarklet — popup mode', () => {
  it('opens the popup synchronously, then hands over the envelope after READY', async () => {
    const env = browser();
    env.run(popupBookmarklet);

    expect(env.opened).toEqual([{ url: `${APP_URL}/capture#n=${NONCE}`, target: '_blank' }]);
    expect(env.events[0]).toBe('open');
    expect(env.status()).toBe('git-moxfield: Sending to git-moxfield…');
    expect(env.body.children[0]?.attributes.role).toBe('status');

    await flush();
    expect(env.fetched).toEqual([
      'https://api2.moxfield.com/v3/decks/all/FixtureDeckId_00000001',
      'https://api2.moxfield.com/v1/decks/Fx001/primer',
    ]);
    expect(env.posted).toEqual([]);

    env.dispatch({ source: env.popup, origin: APP_URL, data: { t: READY, n: NONCE } });
    env.dispatch({ source: env.popup, origin: APP_URL, data: { t: READY, n: NONCE } });
    await flush();

    expect(env.posted).toHaveLength(1);
    const [message] = env.posted;
    expect(message?.targetOrigin).toBe(APP_URL);
    expect(message?.data.t).toBe(PAYLOAD);
    expect(message?.data.n).toBe(NONCE);
    // The key travels with the deck, only to the exact app origin (targetOrigin above).
    expect(message?.data.key).toBe(KEY);
    const parsed: unknown = JSON.parse(String(message?.data.json));
    expect(isCaptureEnvelope(parsed)).toBe(true);
    expect(parsed).toEqual({
      kind: CAPTURE_ENVELOPE_KIND,
      version: CAPTURE_PROTOCOL_VERSION,
      source: 'moxfield',
      pageUrl: 'https://moxfield.com/decks/FixtureDeckId_00000001/primer',
      capturedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown,
      deck: v3Deck(),
      primer: v1Primer(),
      primerError: null,
    });
    expect(parseMoxfieldCapture(message?.data.json)).toEqual({ deck: v3Deck(), primer: v1Primer() });

    env.dispatch({ source: env.popup, origin: APP_URL, data: { t: DONE, n: NONCE } });
    expect(env.listeners.size).toBe(0);
    expect(env.status()).toBe('git-moxfield: Sent');
  });

  it('ignores messages with the wrong source, origin or nonce', async () => {
    const env = browser();
    env.run(popupBookmarklet);
    await flush();
    env.dispatch({ source: {}, origin: APP_URL, data: { t: READY, n: NONCE } });
    env.dispatch({ source: env.popup, origin: 'https://evil.example', data: { t: READY, n: NONCE } });
    env.dispatch({ source: env.popup, origin: APP_URL, data: { t: READY, n: 'cd'.repeat(16) } });
    env.dispatch({ source: env.popup, origin: APP_URL, data: 'git-moxfield:ready' });
    env.dispatch({ source: env.popup, origin: APP_URL, data: null });
    await flush();
    expect(env.posted).toEqual([]);
    expect(env.listeners.size).toBe(1);
  });

  it('records a primer failure without failing the capture', async () => {
    const env = browser({
      respond: (url) =>
        url.includes('/primer')
          ? { ok: false, status: 500, json: () => Promise.resolve({}) }
          : { ok: true, status: 200, json: () => Promise.resolve(v3Deck()) },
    });
    env.run(popupBookmarklet);
    env.dispatch({ source: env.popup, origin: APP_URL, data: { t: READY, n: NONCE } });
    await flush();
    const parsed = JSON.parse(String(env.posted[0]?.data.json)) as Record<string, unknown>;
    expect(parsed.primer).toBeNull();
    expect(parsed.primerError).toBe(
      'Primer not captured: Moxfield answered HTTP 500 for /v1/decks/Fx001/primer',
    );
  });

  it('sends ERROR when the deck cannot be read', async () => {
    const env = browser({ respond: () => ({ ok: false, status: 403, json: () => Promise.resolve({}) }) });
    env.run(popupBookmarklet);
    env.dispatch({ source: env.popup, origin: APP_URL, data: { t: READY, n: NONCE } });
    await flush();
    expect(env.posted).toEqual([
      {
        data: {
          t: ERROR,
          n: NONCE,
          message: 'Moxfield answered HTTP 403 for /v3/decks/all/FixtureDeckId_00000001',
        },
        targetOrigin: APP_URL,
      },
    ]);
    expect(env.listeners.size).toBe(0);
    expect(env.status()).toContain('Could not read the deck');
  });

  it('reports an import error sent back by the capture page', () => {
    const env = browser();
    env.run(popupBookmarklet);
    env.dispatch({
      source: env.popup,
      origin: APP_URL,
      data: { t: ERROR, n: NONCE, message: 'Deck not tracked' },
    });
    expect(env.listeners.size).toBe(0);
    expect(env.status()).toBe('git-moxfield: Could not import the deck: Deck not tracked');
  });

  it('gives up after the timeout', () => {
    const env = browser();
    env.run(popupBookmarklet);
    env.fireTimers(120_000);
    expect(env.listeners.size).toBe(0);
    expect(env.status()).toContain('No answer from http://localhost:3000');
  });

  it('copies the envelope to the clipboard when the popup is blocked', async () => {
    const env = browser({ popupBlocked: true });
    env.run(popupBookmarklet);
    expect(env.clipboard.items).toHaveLength(1);
    const blob = await env.clipboard.items[0]?.items['text/plain'];
    const parsed: unknown = JSON.parse((await blob?.text()) ?? '');
    expect(parseMoxfieldCapture(parsed)).toEqual({ deck: v3Deck(), primer: v1Primer() });
    await flush();
    expect(env.alerts).toEqual([
      'git-moxfield: the popup was blocked, so the deck data was copied to your clipboard instead. Paste it at http://localhost:3000/capture?mode=paste',
    ]);
  });

  it('falls back to writeText when ClipboardItem writes fail', async () => {
    const env = browser({ popupBlocked: true, clipboardWrite: 'reject' });
    env.run(popupBookmarklet);
    await flush();
    expect(env.clipboard.texts).toHaveLength(1);
    expect(parseMoxfieldCapture(env.clipboard.texts[0])).toEqual({ deck: v3Deck(), primer: v1Primer() });
    expect(env.alerts[0]).toContain('/capture?mode=paste');
  });

  it('refuses to run outside a Moxfield deck page', async () => {
    for (const href of [
      'https://moxfield.com/decks/',
      'https://moxfield.com/users/fixture-user',
      'https://evil.example/decks/FixtureDeckId_00000001',
    ]) {
      const env = browser({ href });
      env.run(popupBookmarklet);
      await flush();
      expect(env.opened).toEqual([]);
      expect(env.fetched).toEqual([]);
      expect(env.alerts).toEqual([
        'git-moxfield: open a deck on https://moxfield.com first, then run this bookmarklet again.',
      ]);
    }
  });
});

describe('bookmarklet — same-tab mode', () => {
  it('posts the bookmarklet key and the envelope to the capture form endpoint', async () => {
    const env = browser();
    env.run(sameTabBookmarklet);
    expect(env.opened).toEqual([]);
    await flush();
    const form = env.created.find((element) => element.tagName === 'form');
    expect(form).toMatchObject({
      method: 'POST',
      action: `${APP_URL}/api/capture/form`,
      target: '_self',
      submitted: true,
    });
    expect(form?.children.map((field) => [field.tagName, field.name])).toEqual([
      ['input', CAPTURE_FORM_TOKEN_FIELD],
      ['textarea', CAPTURE_FORM_FIELD],
    ]);
    const [token, payload] = form?.children ?? [];
    expect(token).toMatchObject({ type: 'hidden', name: 'token', value: KEY });
    expect(payload?.name).toBe('payload');
    expect(parseMoxfieldCapture(payload?.value)).toEqual({ deck: v3Deck(), primer: v1Primer() });
    expect(env.body.children).toContain(form);
  });

  it('alerts when the deck cannot be read', async () => {
    const env = browser({ respond: () => ({ ok: false, status: 404, json: () => Promise.resolve({}) }) });
    env.run(sameTabBookmarklet);
    await flush();
    expect(env.created.some((element) => element.tagName === 'form')).toBe(false);
    expect(env.alerts[0]).toContain('could not read the deck: Moxfield answered HTTP 404');
  });
});
