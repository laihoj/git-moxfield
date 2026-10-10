/**
 * Mock Moxfield for development and end-to-end tests (no dependencies beyond node:http).
 *
 *   pnpm mock-moxfield        listens on MOCK_MOXFIELD_PORT (default 4010) on
 *                             MOCK_MOXFIELD_HOST (default 127.0.0.1)
 *
 * One origin plays both Moxfield hosts, so the app is pointed at it with
 * `MOXFIELD_API_BASE_URL`, `MOXFIELD_SITE_ORIGIN` and `CAPTURE_ALLOWED_ORIGINS`
 * (see `pnpm dev:mock` and `playwright.config.ts`):
 *
 * Moxfield API (payloads built by `tests/support/moxfield-deck-builder.ts`):
 *   GET  /v3/decks/all/:publicId           deck JSON, 404 for unknown decks
 *   GET  /v1/decks/:internalId/primer      primer JSON, 404 for unknown decks
 *
 * Moxfield site:
 *   GET  /decks/:publicId[/...]            minimal deck page; the bookmarklet runs here and
 *                                          fetches the API same-origin (no COOP, no CSP).
 *                                          Sent with `Referrer-Policy: no-referrer`, so the
 *                                          browser posts the same-tab bookmarklet's form
 *                                          with `Origin: null`, as it does from the real
 *                                          https://moxfield.com to an http:// git-moxfield
 *                                          (see {@link DECK_PAGE_HEADERS})
 *   GET  /                                 index of the mock's decks
 *
 * Control API (JSON; errors are `{ error }` with status 400/404/405/409/413):
 *   GET    /__control/state                mode, deck summaries, request log
 *   GET    /__control/decks/:publicId      the deck spec
 *   PUT    /__control/decks/:publicId      create/replace from a full MoxDeckSpec
 *   DELETE /__control/decks/:publicId      delete (the API then answers 404)
 *   POST   /__control/decks/:publicId/edit apply an array of edit operations atomically;
 *                                          bumps the Moxfield version by one
 *   POST   /__control/mode                 { mode: ok | blocked | rate-limited | down | primer-down }
 *   POST   /__control/reset                back to the seeded scenarios, mode ok, empty log
 *
 * Failure modes are documented on `MOCK_MODES` in `./state`. Every request is logged as
 * one line.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildMoxfieldDeck, buildMoxfieldPrimer, type MoxDeckSpec } from '../support/moxfield-deck-builder';

import { seedScenarios } from './scenarios';
import {
  MOCK_ZONES,
  MockMoxfieldState,
  MockRequestError,
  toCardObject,
  zoneCounts,
  type MockClientKind,
  type MockMoxfieldStateOptions,
  type MockZone,
} from './state';

/** Port used when `MOCK_MOXFIELD_PORT` is not set. */
export const DEFAULT_MOCK_MOXFIELD_PORT = 4010;
/** Loopback only by default: the control API can change what the mock serves. */
export const DEFAULT_MOCK_MOXFIELD_HOST = '127.0.0.1';

/** Largest accepted control request body. */
const MAX_BODY_BYTES = 2_000_000;

const ZONE_LABELS: Record<MockZone, string> = {
  commanders: 'Commanders',
  companions: 'Companion',
  mainboard: 'Mainboard',
  sideboard: 'Sideboard',
  considering: 'Considering',
};

export interface MockMoxfieldServerOptions {
  /** State to serve. Default: a new state seeded with {@link seedScenarios}. */
  state?: MockMoxfieldState;
  /** Clock for a default state. Ignored when `state` is given. */
  now?: MockMoxfieldStateOptions['now'];
  /** Receives one line per request. Default: `console.log`. */
  log?: (line: string) => void;
}

/** A complete HTTP answer; handlers build these and the server writes them. */
interface MockResponse {
  status: number;
  body: string;
  contentType: string;
  headers?: Record<string, string>;
}

interface RequestContext {
  req: IncomingMessage;
  method: string;
  /** Decoded path segments, e.g. `['v3', 'decks', 'all', 'abc']` for `/v3/decks/all/abc`. */
  segments: string[];
  state: MockMoxfieldState;
  client: MockClientKind;
}

function json(status: number, body: unknown, headers?: Record<string, string>): MockResponse {
  return { status, body: JSON.stringify(body), contentType: 'application/json; charset=utf-8', headers };
}

function html(status: number, body: string, headers?: Record<string, string>): MockResponse {
  return { status, body, contentType: 'text/html; charset=utf-8', headers };
}

function text(status: number, body: string): MockResponse {
  return { status, body, contentType: 'text/plain; charset=utf-8' };
}

function controlError(status: number, message: string): MockResponse {
  return json(status, { error: message });
}

const NOT_FOUND = json(404, { type: 'about:blank', title: 'Not Found', status: 404 });

function methodNotAllowed(allowed: readonly string[]): MockResponse {
  return json(405, { error: 'Method not allowed' }, { allow: allowed.join(', ') });
}

function isRead(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

/**
 * Tells browsers from server-side clients the way the mock's `blocked` mode needs it:
 * browsers send a `Mozilla/…` User-Agent and the `Sec-Fetch-Site` Fetch Metadata header
 * (which page scripts cannot set). Node's fetch sends neither (it only adds
 * `Sec-Fetch-Mode`), and git-moxfield never sends a browser User-Agent.
 */
function clientKind(req: IncomingMessage): MockClientKind {
  const userAgent = req.headers['user-agent'] ?? '';
  return userAgent.startsWith('Mozilla/') && req.headers['sec-fetch-site'] !== undefined
    ? 'browser'
    : 'server';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(new MockRequestError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (tooLarge) return;
      const body = Buffer.concat(chunks).toString('utf8');
      if (body.trim() === '') {
        resolveBody(undefined);
        return;
      }
      try {
        resolveBody(JSON.parse(body) as unknown);
      } catch {
        reject(new MockRequestError(400, 'Request body is not valid JSON'));
      }
    });
  });
}

/** The failure the current mode produces for an API request, or `null` to serve it normally. */
function modeFailure(ctx: RequestContext, endpoint: 'deck' | 'primer'): MockResponse | null {
  switch (ctx.state.mode) {
    case 'ok':
      return null;
    case 'blocked':
      if (ctx.client === 'browser') return null;
      return {
        status: 403,
        contentType: 'text/html; charset=UTF-8',
        headers: { 'cf-ray': `${randomBytes(8).toString('hex')}-MOCK`, server: 'cloudflare' },
        body:
          '<!DOCTYPE html><html lang="en"><head><title>Attention Required! | Cloudflare</title></head>' +
          '<body><h1>Sorry, you have been blocked</h1><p>You are unable to access moxfield.com (mock).</p></body></html>',
      };
    case 'rate-limited':
      return json(429, { title: 'Too Many Requests', status: 429 }, { 'retry-after': '30' });
    case 'down':
      return text(502, 'Bad Gateway');
    case 'primer-down':
      // Plain text without cf-ray, so the adapter sees an outage rather than a block.
      return endpoint === 'primer' ? text(503, 'Service Unavailable') : null;
  }
}

/**
 * Extra headers of the deck page.
 *
 * A form POST from https://moxfield.com to git-moxfield on http://localhost carries
 * `Origin: null`: under Moxfield's (default) referrer policy the browser hides the
 * origin of a non-CORS request that downgrades from https to http. The mock and the e2e
 * app both run on http://, so there is no downgrade; `no-referrer` makes browsers send
 * `Origin: null` for the same reason, which keeps the e2e suite honest about what the
 * same-tab capture endpoint receives in real use.
 */
export const DECK_PAGE_HEADERS: Readonly<Record<string, string>> = { 'referrer-policy': 'no-referrer' };

const PAGE_STYLE = `
  :root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
  body { margin: 0; padding: 24px 16px; }
  main { max-width: 760px; margin: 0 auto; }
  .note { display: inline-block; margin: 0 0 8px; padding: 2px 8px; border-radius: 6px; background: #fde68a; color: #422006; font-size: 13px; }
  h1 { margin: 0 0 4px; }
  .muted { color: #6b7280; }
  ul { padding-left: 20px; columns: 2 220px; }
  a { color: #7c3aed; }
`;

function htmlPage(title: string, body: string): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${PAGE_STYLE}</style>`,
    '</head>',
    `<body><main>${body}</main></body>`,
    '</html>',
  ].join('\n');
}

function deckPage(deck: MoxDeckSpec): string {
  const name = deck.name ?? 'Fixture Deck';
  const commanders = (deck.commanders ?? []).map((card) => toCardObject(card).name);
  const counts = zoneCounts(deck);
  const sections = MOCK_ZONES.filter((zone) => counts[zone] > 0).map((zone) => {
    const items = (deck[zone] ?? []).map((spec) => {
      const card = toCardObject(spec);
      return `<li>${card.quantity ?? 1} ${escapeHtml(card.name)}</li>`;
    });
    return `<section><h2>${ZONE_LABELS[zone]} (${counts[zone]})</h2><ul>${items.join('')}</ul></section>`;
  });
  return htmlPage(
    `${name} // Commander deck list mtg // Moxfield`,
    [
      '<p class="note">Mock Moxfield deck page</p>',
      `<h1>${escapeHtml(name)}</h1>`,
      commanders.length > 0 ? `<p>${commanders.map(escapeHtml).join(' · ')}</p>` : '',
      `<p class="muted">Version ${deck.version ?? 1} · last updated ${escapeHtml(deck.lastUpdatedAtUtc ?? 'unknown')}</p>`,
      '<p class="muted">Run the git-moxfield bookmarklet on this page to capture the deck.</p>',
      ...sections,
    ].join('\n'),
  );
}

function indexPage(state: MockMoxfieldState): string {
  const items = state
    .snapshot()
    .decks.map(
      (deck) =>
        `<li><a href="/decks/${encodeURIComponent(deck.publicId)}">${escapeHtml(deck.name)}</a> ` +
        `<span class="muted">${escapeHtml(deck.publicId)} · version ${deck.version}</span></li>`,
    );
  return htmlPage(
    'Mock Moxfield',
    [
      '<p class="note">Mock Moxfield</p>',
      '<h1>Decks</h1>',
      `<ul>${items.join('')}</ul>`,
      `<p class="muted">Mode: ${state.mode}. Control API: <a href="/__control/state">/__control/state</a>.</p>`,
    ].join('\n'),
  );
}

/**
 * Moxfield-facing routes (API and deck pages); `null` when the path is not one of them.
 * Their requests are recorded in the state's request log.
 */
function moxfieldRoute(ctx: RequestContext): MockResponse | null {
  const { segments, state } = ctx;
  const [first, second, third, fourth, ...rest] = segments;

  // GET /v3/decks/all/:publicId
  if (first === 'v3' && second === 'decks' && third === 'all' && fourth !== undefined && rest.length === 0) {
    const deck = state.getDeck(fourth);
    return modeFailure(ctx, 'deck') ?? (deck ? json(200, buildMoxfieldDeck(deck)) : NOT_FOUND);
  }
  // GET /v1/decks/:internalId/primer
  if (
    first === 'v1' &&
    second === 'decks' &&
    third !== undefined &&
    fourth === 'primer' &&
    rest.length === 0
  ) {
    const deck = state.findDeckByInternalId(third);
    return modeFailure(ctx, 'primer') ?? (deck ? json(200, buildMoxfieldPrimer(deck)) : NOT_FOUND);
  }
  // GET /decks/:publicId[/...]
  if (first === 'decks' && second !== undefined) {
    const deck = state.getDeck(second);
    return deck
      ? html(200, deckPage(deck), { ...DECK_PAGE_HEADERS })
      : html(404, htmlPage('Deck not found // Moxfield', '<h1>Deck not found</h1>'));
  }
  return null;
}

async function controlRoute(ctx: RequestContext, route: readonly string[]): Promise<MockResponse> {
  const { method, req, state } = ctx;
  const [resource, id, action, ...rest] = route;

  if (resource === 'state' && id === undefined) {
    return isRead(method) ? json(200, state.snapshot()) : methodNotAllowed(['GET', 'HEAD']);
  }
  if (resource === 'mode' && id === undefined) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    return json(200, { mode: state.setMode(await readJsonBody(req)) });
  }
  if (resource === 'reset' && id === undefined) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    state.reset();
    return json(200, state.snapshot());
  }
  if (resource === 'decks' && id !== undefined && action === undefined) {
    switch (method) {
      case 'GET':
      case 'HEAD': {
        const deck = state.getDeck(id);
        return deck ? json(200, { deck }) : controlError(404, `Unknown deck ${id}`);
      }
      case 'PUT': {
        const { deck, created } = state.putDeck(id, await readJsonBody(req));
        return json(created ? 201 : 200, { deck });
      }
      case 'DELETE':
        return state.deleteDeck(id) ? json(200, { deleted: id }) : controlError(404, `Unknown deck ${id}`);
      default:
        return methodNotAllowed(['GET', 'HEAD', 'PUT', 'DELETE']);
    }
  }
  if (resource === 'decks' && id !== undefined && action === 'edit' && rest.length === 0) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    return json(200, { deck: state.editDeck(id, await readJsonBody(req)) });
  }
  return NOT_FOUND;
}

async function route(ctx: RequestContext): Promise<MockResponse> {
  const { method, segments, state } = ctx;
  if (segments[0] === '__control') return controlRoute(ctx, segments.slice(1));

  if (!isRead(method)) return methodNotAllowed(['GET', 'HEAD']);
  const moxfield = moxfieldRoute(ctx);
  if (moxfield) {
    state.recordRequest({ method, path: ctx.req.url ?? '/', status: moxfield.status, client: ctx.client });
    return moxfield;
  }
  if (segments.length === 0) return html(200, indexPage(state));
  if (segments.length === 1 && segments[0] === 'favicon.ico')
    return { status: 204, body: '', contentType: 'text/plain' };
  return NOT_FOUND;
}

function decodeSegments(pathname: string): string[] {
  try {
    return pathname
      .split('/')
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    throw new MockRequestError(400, 'Malformed URL path');
  }
}

/** Creates (but does not start) the mock server. */
export function createMockMoxfieldServer(options: MockMoxfieldServerOptions = {}): {
  server: Server;
  state: MockMoxfieldState;
} {
  const state = options.state ?? new MockMoxfieldState({ seed: seedScenarios, now: options.now });
  const log =
    options.log ??
    ((line: string) => {
      console.log(line);
    });

  const server = createServer((req, res) => {
    const started = performance.now();
    const method = req.method ?? 'GET';
    const client = clientKind(req);
    res.on('finish', () => {
      const ms = Math.round(performance.now() - started);
      const mode = state.mode === 'ok' ? '' : ` [${state.mode}]`;
      log(`[mock-moxfield] ${method} ${req.url ?? '/'} ${res.statusCode} ${ms}ms ${client}${mode}`);
    });

    const respond = async (): Promise<MockResponse> => {
      const { pathname } = new URL(req.url ?? '/', 'http://mock.invalid');
      return route({ req, method, segments: decodeSegments(pathname), state, client });
    };
    respond()
      .catch((error: unknown): MockResponse => {
        if (error instanceof MockRequestError) {
          // Discard whatever is left of a rejected body.
          req.resume();
          return controlError(error.status, error.message);
        }
        log(
          `[mock-moxfield] internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
        return controlError(500, 'Internal mock error');
      })
      .then(
        (response) => {
          res.writeHead(response.status, {
            'content-type': response.contentType,
            'cache-control': 'no-store',
            'content-length': String(Buffer.byteLength(response.body)),
            ...response.headers,
          });
          res.end(response.body);
        },
        (error: unknown) => {
          log(`[mock-moxfield] could not write the response: ${String(error)}`);
          res.destroy();
        },
      );
  });
  return { server, state };
}

export interface StartMockMoxfieldOptions extends MockMoxfieldServerOptions {
  /** Default {@link DEFAULT_MOCK_MOXFIELD_PORT}; `0` picks a free port. */
  port?: number;
  /** Default {@link DEFAULT_MOCK_MOXFIELD_HOST}. */
  host?: string;
}

export interface RunningMockMoxfield {
  /** Base URL without trailing slash, e.g. `http://127.0.0.1:4010`. */
  url: string;
  port: number;
  server: Server;
  state: MockMoxfieldState;
  /** Stops listening and closes open connections. */
  close(): Promise<void>;
}

function urlHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return 'localhost';
  return host.includes(':') ? `[${host}]` : host;
}

/** Starts the mock server and resolves once it is listening. */
export async function startMockMoxfield(
  options: StartMockMoxfieldOptions = {},
): Promise<RunningMockMoxfield> {
  const { server, state } = createMockMoxfieldServer(options);
  const host = options.host ?? DEFAULT_MOCK_MOXFIELD_HOST;
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_MOCK_MOXFIELD_PORT, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${urlHost(host)}:${port}`,
    port,
    server,
    state,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolveClose();
        });
        server.closeAllConnections();
      }),
  };
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_MOCK_MOXFIELD_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`MOCK_MOXFIELD_PORT must be a port number, got ${JSON.stringify(value)}`);
  }
  return port;
}

async function main(): Promise<void> {
  const port = parsePort(process.env.MOCK_MOXFIELD_PORT);
  const host = process.env.MOCK_MOXFIELD_HOST ?? DEFAULT_MOCK_MOXFIELD_HOST;
  const running = await startMockMoxfield({ port, host });
  const shownUrl = host === DEFAULT_MOCK_MOXFIELD_HOST ? `http://localhost:${running.port}` : running.url;
  console.log(`[mock-moxfield] listening on ${shownUrl}`);
  for (const deck of running.state.listDecks()) {
    console.log(`[mock-moxfield] deck page: ${shownUrl}/decks/${deck.publicId}`);
  }
  const stop = (signal: NodeJS.Signals): void => {
    console.log(`[mock-moxfield] ${signal}, shutting down`);
    running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(
      `[mock-moxfield] failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
