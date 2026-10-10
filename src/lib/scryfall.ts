/**
 * Scryfall card image URLs. Only Scryfall's image CDN is allowed by the Content
 * Security Policy (`img-src https://cards.scryfall.io`).
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * URL of the front face image (`normal` size, 488×680) of a Scryfall printing, or
 * `null` when `scryfallId` is not a well-formed UUID. The id comes from untrusted
 * Moxfield data, so it is validated before it becomes part of a URL.
 */
export function scryfallImageUrl(scryfallId: string | undefined): string | null {
  if (scryfallId === undefined) return null;
  const id = scryfallId.toLowerCase();
  if (!UUID_PATTERN.test(id)) return null;
  return `https://cards.scryfall.io/normal/front/${id.charAt(0)}/${id.charAt(1)}/${id}.jpg`;
}
