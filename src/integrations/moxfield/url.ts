/**
 * Parsing of user-entered Moxfield deck references (URLs or bare deck ids).
 *
 * The parser is strict about *where* a URL points (only the configured Moxfield site,
 * only `/decks/{publicId}`) and lenient about how it was typed (missing scheme, `www.`,
 * trailing `/primer`, query strings, fragments). User input is reduced to a validated
 * deck id; it is never used as a URL itself.
 */
import type { ParseDeckUrlResult } from '../deck-source';

import { DEFAULT_MOXFIELD_SITE_ORIGIN, MOXFIELD_PUBLIC_ID_PATTERN, MOXFIELD_SOURCE_ID } from './constants';

/** Longest input considered at all; real deck URLs are well under 200 characters. */
const MAX_INPUT_LENGTH = 2048;

/**
 * Path segments under `/decks/` that are Moxfield pages rather than deck ids. They
 * match the id pattern, so they are rejected explicitly.
 */
const RESERVED_DECK_PATHS: ReadonlySet<string> = new Set([
  'personal',
  'public',
  'following',
  'liked',
  'bookmarks',
  'bookmarked',
  'search',
  'new',
  'import',
]);

/** Leading `scheme:` of an input; a colon followed by a digit is a port, not a scheme. */
const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):(?!\d)/i;

/** Whether `id` is a syntactically valid Moxfield public deck id. */
export function isValidMoxfieldPublicId(id: string): boolean {
  return MOXFIELD_PUBLIC_ID_PATTERN.test(id) && !RESERVED_DECK_PATHS.has(id.toLowerCase());
}

/**
 * Canonical public URL of a deck: `{siteOrigin}/decks/{publicId}`.
 *
 * @throws {TypeError} when `siteOrigin` is not an absolute URL.
 */
export function moxfieldDeckUrl(publicId: string, siteOrigin: string = DEFAULT_MOXFIELD_SITE_ORIGIN): string {
  return `${new URL(siteOrigin).origin}/decks/${encodeURIComponent(publicId)}`;
}

function siteHost(siteOrigin: string): string | null {
  try {
    return hostWithoutWww(new URL(siteOrigin).host);
  } catch {
    return null;
  }
}

function hostWithoutWww(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

function fail(reason: string): ParseDeckUrlResult {
  return { ok: false, reason };
}

function success(publicId: string, siteOrigin: string): ParseDeckUrlResult {
  return {
    ok: true,
    ref: { source: MOXFIELD_SOURCE_ID, externalId: publicId },
    canonicalUrl: moxfieldDeckUrl(publicId, siteOrigin),
  };
}

/**
 * Parses a Moxfield deck URL or bare public deck id. Never throws.
 *
 * Accepted: `https://moxfield.com/decks/{id}` (also `http:`, `www.`, no scheme, extra
 * path segments such as `/primer`, query strings and fragments) and a bare `{id}`.
 * Rejected: other hosts, other paths, non-http(s) schemes (e.g. `javascript:`),
 * embedded credentials, whitespace inside the input, and malformed ids.
 *
 * @param siteOrigin Origin of the Moxfield site; overridable for tests and mirrors.
 */
export function parseMoxfieldDeckInput(
  input: string,
  siteOrigin: string = DEFAULT_MOXFIELD_SITE_ORIGIN,
): ParseDeckUrlResult {
  const text = input.trim();
  if (text.length === 0) return fail('Enter a Moxfield deck URL or deck id.');
  if (text.length > MAX_INPUT_LENGTH) return fail('That input is too long to be a Moxfield deck URL.');
  if (/\s/.test(text)) return fail('A Moxfield deck URL cannot contain spaces.');

  const expectedHost = siteHost(siteOrigin);
  if (expectedHost === null) return fail('The Moxfield site origin is misconfigured.');

  const scheme = SCHEME_PATTERN.exec(text)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') {
    return fail('Only http(s) links to Moxfield decks are supported.');
  }

  if (!text.includes('/') && !text.includes('.') && !text.includes(':')) {
    return isValidMoxfieldPublicId(text)
      ? success(text, siteOrigin)
      : fail('That is not a valid Moxfield deck id. Paste the deck URL, e.g. https://moxfield.com/decks/…');
  }
  const candidate = scheme !== undefined ? text : text.startsWith('//') ? `https:${text}` : `https://${text}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return fail('That is not a valid URL.');
  }
  if (url.username !== '' || url.password !== '') return fail('Deck URLs must not contain credentials.');
  if (hostWithoutWww(url.host) !== expectedHost) {
    return fail(`Only decks on ${expectedHost} are supported.`);
  }

  const [first, publicId] = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (first !== 'decks' || publicId === undefined) {
    return fail('That Moxfield link does not point to a deck (expected /decks/{id}).');
  }
  if (!isValidMoxfieldPublicId(publicId)) return fail('That Moxfield link contains an invalid deck id.');
  return success(publicId, siteOrigin);
}
