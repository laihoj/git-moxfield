/**
 * Browser capture: parsing what the user's browser hands over (bookmarklet envelope or
 * manually pasted JSON), and building the bookmarklet itself.
 *
 * The protocol is specified in `./capture-protocol`, the transport encoding of the
 * payload (compression) in `./capture-codec-protocol`. {@link parseMoxfieldCapture} takes
 * the capture's JSON text or value, so a compressed payload must be decoded first
 * (`decodeCapturePayload` in `./capture-codec`, which the capture endpoints call).
 */
import { isRecord } from '@/core/guards';
import { parseHttpUrl, stripTrailingSlashes } from '@/core/http-url';
import { formatBytes } from '@/core/text';

import { ENCODE_CAPTURE_PAYLOAD_SOURCE, exceedsUtf8Bytes } from './capture-codec-protocol';
import {
  BOOKMARKLET_KEY_PATTERN,
  CAPTURE_ENVELOPE_KIND,
  CAPTURE_FORM_FIELD,
  CAPTURE_FORM_PATH,
  CAPTURE_FORM_TOKEN_FIELD,
  CAPTURE_PAGE_PATH,
  CAPTURE_PASTE_QUERY,
  CAPTURE_PROTOCOL_VERSION,
  CAPTURE_TIMEOUT_MS,
  classifyCaptureJson,
  DONE,
  ERROR,
  MAX_CAPTURE_BYTES,
  NEW_BOOKMARKLET_HINT,
  PAYLOAD,
  READY,
} from './capture-protocol';
import {
  DEFAULT_MOXFIELD_API_BASE_URL,
  DEFAULT_MOXFIELD_SITE_ORIGIN,
  MOXFIELD_DECK_PATH_PREFIX,
  MOXFIELD_PRIMER_PATH_PREFIX,
  MOXFIELD_PRIMER_PATH_SUFFIX,
  MOXFIELD_PUBLIC_ID_PATTERN_SOURCE,
  MOXFIELD_SOURCE_ID,
} from './constants';
import { moxfieldSchemaError } from './errors';
import { parseMoxfieldDeck, type MoxfieldPayloadData, type PlainObject } from './schema';

const DECK_JSON_HINT = `Expected the JSON of ${DEFAULT_MOXFIELD_API_BASE_URL}${MOXFIELD_DECK_PATH_PREFIX}{deck id}.`;
const PRIMER_JSON_HINT = `Expected the JSON of ${DEFAULT_MOXFIELD_API_BASE_URL}${MOXFIELD_PRIMER_PATH_PREFIX}{internal deck id}${MOXFIELD_PRIMER_PATH_SUFFIX}.`;

/** Parses a JSON string (bounded by {@link MAX_CAPTURE_BYTES}); other values pass through. */
function parseJsonValue(value: unknown, what: string, hint: string): unknown {
  if (typeof value !== 'string') return value;
  if (exceedsUtf8Bytes(value, MAX_CAPTURE_BYTES)) {
    throw moxfieldSchemaError(`The ${what} is too large (limit ${formatBytes(MAX_CAPTURE_BYTES)}).`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw moxfieldSchemaError(`The ${what} is not valid JSON. ${hint}`);
  }
}

/**
 * Lenient primer reading: an absent or blank primer is `null`, unreadable primer JSON
 * becomes a `primerError` so the deck itself can still be ingested.
 */
function readPrimer(value: unknown): { primer: unknown; primerError?: string } {
  if (value === undefined || value === null) return { primer: null };
  if (typeof value === 'string') {
    if (value.trim().length === 0) return { primer: null };
    try {
      return { primer: parseJsonValue(value, 'primer', PRIMER_JSON_HINT) };
    } catch (error) {
      return { primer: null, primerError: error instanceof Error ? error.message : 'Unreadable primer' };
    }
  }
  return { primer: value };
}

function fromEnvelope(envelope: PlainObject): MoxfieldPayloadData {
  if (envelope.version !== CAPTURE_PROTOCOL_VERSION) {
    throw moxfieldSchemaError(
      `This capture uses an unsupported protocol version (expected ${CAPTURE_PROTOCOL_VERSION}): the bookmarklet is out of date. ${NEW_BOOKMARKLET_HINT}`,
    );
  }
  if (envelope.source !== MOXFIELD_SOURCE_ID)
    throw moxfieldSchemaError('The capture does not come from Moxfield.');
  const primerError = typeof envelope.primerError === 'string' ? envelope.primerError : undefined;
  const primer = primerError === undefined ? readPrimer(envelope.primer) : { primer: null, primerError };
  return { deck: envelope.deck, ...primer };
}

function fromWrapper(wrapper: PlainObject): MoxfieldPayloadData {
  const deck = parseJsonValue(wrapper.deck, 'deck JSON', DECK_JSON_HINT);
  if (typeof wrapper.primerError === 'string') {
    return { deck, primer: null, primerError: wrapper.primerError };
  }
  return { deck, ...readPrimer(wrapper.primer) };
}

/**
 * Validates data handed over by the user's browser and returns it as
 * {@link MoxfieldPayloadData}, keeping the deck and primer JSON untouched (they are
 * stored as the raw payload).
 *
 * Accepted (as an object or as a JSON string):
 * - a bookmarklet {@link import('./capture-protocol').CaptureEnvelope};
 * - `{ deck, primer?, primerError? }`, where `deck`/`primer` may themselves be JSON
 *   strings (e.g. from two paste fields);
 * - a bare v3 or legacy v2 deck object (manual paste; the primer is then unknown).
 *
 * `separatePrimer`, when given and non-blank, is a separately pasted primer (object or
 * JSON string) and replaces any primer found in `data`. Unreadable primer data never
 * fails the capture; it becomes a `primerError`.
 *
 * @throws {DeckSourceError} code `schema` when no usable deck is found.
 */
export function parseMoxfieldCapture(data: unknown, separatePrimer?: unknown): MoxfieldPayloadData {
  if (typeof data === 'string' && data.trim().length === 0) {
    throw moxfieldSchemaError(`Nothing was pasted. ${DECK_JSON_HINT}`);
  }
  const value = parseJsonValue(data, 'pasted data', DECK_JSON_HINT);
  if (!isRecord(value)) throw moxfieldSchemaError(`The data is not a Moxfield deck. ${DECK_JSON_HINT}`);

  let payload: MoxfieldPayloadData;
  switch (classifyCaptureJson(value)) {
    case 'envelope':
      payload = fromEnvelope(value);
      break;
    case 'wrapper':
      payload = fromWrapper(value);
      break;
    case 'primer':
      throw moxfieldSchemaError(`This looks like the primer JSON, not the deck. ${DECK_JSON_HINT}`);
    case 'other':
      payload = { deck: value, primer: null };
      break;
  }

  if (separatePrimer !== undefined && !(typeof separatePrimer === 'string' && separatePrimer.trim() === '')) {
    payload = { deck: payload.deck, ...readPrimer(separatePrimer) };
  }

  const deck = parseMoxfieldDeck(payload.deck);
  if (!deck.ok) {
    throw moxfieldSchemaError(
      `The data is not a usable Moxfield deck (${deck.issues.slice(0, 10).join('; ')}). ${DECK_JSON_HINT}`,
    );
  }
  return payload;
}

export interface BookmarkletOptions {
  /**
   * `popup` (desktop): popup + `postMessage`; the capture page submits the deck
   * same-origin. `same-tab` (phones and in-app browsers): form POST to git-moxfield in
   * the same tab.
   */
  mode: 'popup' | 'same-tab';
  /** Public base URL of git-moxfield, e.g. `http://localhost:3000`. */
  appUrl: string;
  /** Moxfield API base URL. Defaults to `https://api2.moxfield.com`. */
  apiBaseUrl?: string;
  /** Moxfield site origin the bookmarklet must run on. Defaults to `https://moxfield.com`. */
  siteOrigin?: string;
  /**
   * The owner's bookmarklet key ({@link BOOKMARKLET_KEY_PATTERN}). Both modes embed it:
   * popup mode hands it to the capture page with the deck (PAYLOAD), same-tab mode posts
   * it as the form field {@link CAPTURE_FORM_TOKEN_FIELD}. It authenticates the capture
   * and signs the browser in as the key's owner.
   */
  key: string;
}

/** Absolute http(s) URL without trailing slash, query or fragment. */
function baseUrl(value: string, option: string): URL {
  const url = parseHttpUrl(value);
  if (url === null) {
    throw new TypeError(
      `buildBookmarklet: ${option} must be an absolute http(s) URL, got ${JSON.stringify(value)}`,
    );
  }
  url.search = '';
  url.hash = '';
  url.pathname = stripTrailingSlashes(url.pathname);
  return url;
}

/**
 * Shared prelude: status overlay (textContent only), deck/primer fetching, the payload
 * encoder and the deck-page check. `C` is the JSON-encoded configuration.
 *
 * `capture(id)` resolves with the capture payload: the envelope JSON, compressed by
 * `encode` (`ENCODE_CAPTURE_PAYLOAD_SOURCE`, which returns the JSON unchanged in browsers
 * without `CompressionStream`). Should compressing fail anyway, the plain JSON is sent:
 * the server accepts both. Both modes send this one payload everywhere it goes (PAYLOAD
 * message, form field, clipboard).
 */
const PRELUDE = String.raw`
const encode = ${ENCODE_CAPTURE_PAYLOAD_SOURCE};
let box = null;
const say = (text, bad) => {
  try {
    if (!box) {
      box = document.createElement('div');
      box.setAttribute('role', 'status');
      box.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:min(360px,calc(100vw - 32px));padding:10px 14px;border-radius:8px;font:13px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.3)';
      document.body.appendChild(box);
    }
    box.style.background = bad ? '#b91c1c' : '#1f2937';
    box.textContent = 'git-moxfield: ' + text;
  } catch (_) {}
};
const hide = (ms) => setTimeout(() => {
  if (box) {
    box.remove();
    box = null;
  }
}, ms);
const why = (e) => (e && e.message) || String(e);
const get = async (path) => {
  const r = await fetch(C.api + path, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('Moxfield answered HTTP ' + r.status + ' for ' + path);
  return r.json();
};
const capture = async (id) => {
  const deck = await get(C.deckPath + encodeURIComponent(id));
  let primer = null;
  let primerError = null;
  try {
    if (!deck || typeof deck.id !== 'string') throw new Error('the deck has no internal id');
    primer = await get(C.primerPrefix + encodeURIComponent(deck.id) + C.primerSuffix);
  } catch (e) {
    primerError = 'Primer not captured: ' + why(e);
  }
  const json = JSON.stringify({ kind: C.kind, version: C.version, source: 'moxfield', pageUrl: location.origin + location.pathname, capturedAt: new Date().toISOString(), deck, primer, primerError });
  try {
    return await encode(json);
  } catch (_) {
    return json;
  }
};
const m = new RegExp('^/decks/(' + C.idPattern + ')(?:/|$)').exec(location.pathname);
if (location.origin !== C.site || !m) {
  alert('git-moxfield: open a deck on ' + C.site + ' first, then run this bookmarklet again.');
  return;
}
`;

/**
 * Popup mode: window.open first (synchronously), then postMessage handshake. When the
 * popup is blocked, the payload goes to the clipboard for the capture page's paste form.
 */
const POPUP_MODE = String.raw`
const n = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
const popup = window.open(C.app + C.capturePath + '#n=' + n, '_blank');
const payload = capture(m[1]);
if (!popup) {
  const pasteUrl = C.app + C.capturePath + '?' + C.pasteQuery;
  const copied = () => {
    say('Popup blocked. The deck was copied; paste it at ' + pasteUrl);
    alert('git-moxfield: the popup was blocked, so the deck data was copied to your clipboard instead. Paste it at ' + pasteUrl);
  };
  const failed = (e) => {
    say('Could not copy the deck: ' + why(e), true);
    alert('git-moxfield: the popup was blocked and the deck could not be copied (' + why(e) + '). Allow popups for this site and try again.');
  };
  const copyText = () => payload.then((t) => navigator.clipboard.writeText(t)).then(copied, failed);
  say('Popup blocked; copying the deck to the clipboard…');
  try {
    navigator.clipboard.write([new ClipboardItem({ 'text/plain': payload.then((t) => new Blob([t], { type: 'text/plain' })) })]).then(copied, copyText);
  } catch (_) {
    copyText();
  }
  return;
}
say('Sending to git-moxfield…');
let answered = false;
let timer = 0;
const stop = () => {
  window.removeEventListener('message', onMessage);
  clearTimeout(timer);
};
const onMessage = (e) => {
  const d = e.data;
  if (e.source !== popup || e.origin !== C.appOrigin || !d || typeof d !== 'object' || d.n !== n) return;
  if (d.t === C.ready && !answered) {
    answered = true;
    payload.then(
      (j) => popup.postMessage({ t: C.payload, n, json: j, key: C.key }, C.appOrigin),
      (err) => {
        popup.postMessage({ t: C.error, n, message: why(err) }, C.appOrigin);
        stop();
      },
    );
  } else if (d.t === C.done) {
    stop();
    say('Sent');
    hide(3000);
  } else if (d.t === C.error) {
    stop();
    say('Could not import the deck: ' + String(d.message), true);
  }
};
window.addEventListener('message', onMessage);
timer = setTimeout(() => {
  stop();
  say('No answer from ' + C.app + '. Is git-moxfield running? Run the bookmarklet again.', true);
}, C.timeout);
payload.catch((e) => say('Could not read the deck: ' + why(e), true));
`;

/** Same-tab mode: fetch, then POST the key and the payload to git-moxfield in this tab. */
const SAME_TAB_MODE = String.raw`
say('Reading the deck…');
capture(m[1]).then((j) => {
  const f = document.createElement('form');
  f.method = 'POST';
  f.action = C.app + C.formPath;
  f.target = '_self';
  f.acceptCharset = 'UTF-8';
  f.style.display = 'none';
  const k = document.createElement('input');
  k.type = 'hidden';
  k.name = C.tokenField;
  k.value = C.key;
  f.appendChild(k);
  const t = document.createElement('textarea');
  t.name = C.field;
  t.value = j;
  f.appendChild(t);
  document.body.appendChild(f);
  say('Opening git-moxfield…');
  f.submit();
}).catch((e) => {
  say('Could not read the deck: ' + why(e), true);
  alert('git-moxfield: could not read the deck: ' + why(e));
});
`;

/** Source text with every line trimmed and empty lines dropped: what the builder puts in the URL. */
export function compactBookmarkletSource(source: string): string {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Builds the "Send to git-moxfield" bookmarklet as a `javascript:` URL.
 *
 * The script is self-contained ES2020 (no external scripts), runs only on
 * `{siteOrigin}/decks/{id}`, fetches the deck and primer endpoints as the user's own
 * browser, and hands the {@link import('./capture-protocol').CaptureEnvelope} to
 * git-moxfield as described in `./capture-protocol`, gzip-compressed as described in
 * `./capture-codec-protocol` (plain JSON in browsers that cannot compress). Messages are
 * only exchanged with the exact app origin (never `'*'`) and carry a fresh 128-bit nonce.
 * A small status overlay on the Moxfield page reports progress; failures end in an
 * `alert`.
 *
 * Each mode embeds only the configuration it uses. Both carry the owner's key, which
 * makes every bookmarklet a credential: whoever holds it can send decks to its owner's
 * account and sign in as its owner. Show it only to its owner, once, and never log it.
 *
 * @throws {TypeError} when a URL option is not an absolute http(s) URL or the key is not
 * a well-formed bookmarklet key.
 */
export function buildBookmarklet(options: BookmarkletOptions): string {
  const app = baseUrl(options.appUrl, 'appUrl');
  const api = baseUrl(options.apiBaseUrl ?? DEFAULT_MOXFIELD_API_BASE_URL, 'apiBaseUrl');
  const site = baseUrl(options.siteOrigin ?? DEFAULT_MOXFIELD_SITE_ORIGIN, 'siteOrigin');
  // Checked at runtime too: a malformed key would only fail later, on every capture.
  if (typeof options.key !== 'string' || !BOOKMARKLET_KEY_PATTERN.test(options.key)) {
    throw new TypeError('buildBookmarklet: key must be a well-formed bookmarklet key');
  }
  const common = {
    app: stripTrailingSlashes(app.href),
    api: stripTrailingSlashes(api.href),
    site: site.origin,
    idPattern: MOXFIELD_PUBLIC_ID_PATTERN_SOURCE,
    deckPath: MOXFIELD_DECK_PATH_PREFIX,
    primerPrefix: MOXFIELD_PRIMER_PATH_PREFIX,
    primerSuffix: MOXFIELD_PRIMER_PATH_SUFFIX,
    kind: CAPTURE_ENVELOPE_KIND,
    version: CAPTURE_PROTOCOL_VERSION,
    key: options.key,
  };
  let config: Record<string, string | number>;
  let modeScript: string;
  if (options.mode === 'popup') {
    config = {
      ...common,
      appOrigin: app.origin,
      ready: READY,
      payload: PAYLOAD,
      error: ERROR,
      done: DONE,
      capturePath: CAPTURE_PAGE_PATH,
      pasteQuery: CAPTURE_PASTE_QUERY,
      timeout: CAPTURE_TIMEOUT_MS,
    };
    modeScript = POPUP_MODE;
  } else {
    config = {
      ...common,
      formPath: CAPTURE_FORM_PATH,
      field: CAPTURE_FORM_FIELD,
      tokenField: CAPTURE_FORM_TOKEN_FIELD,
    };
    modeScript = SAME_TAB_MODE;
  }
  const body = [
    'void (() => {',
    `const C = ${JSON.stringify(config)};`,
    'try {',
    PRELUDE,
    modeScript,
    '} catch (e) {',
    "alert('git-moxfield: ' + ((e && e.message) || String(e)));",
    '}',
    '})();',
  ].join('\n');
  return `javascript:${encodeURIComponent(compactBookmarkletSource(body))}`;
}
