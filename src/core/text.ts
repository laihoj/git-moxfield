/**
 * Small, dependency-free text helpers shared by the core, the adapters, the server and
 * the browser: plurals and lists for running text, capitalization, and the normalization
 * every comparison and every stored label goes through. Pure, so output is deterministic
 * and can be asserted exactly.
 */

/** U+2212 MINUS SIGN, typographically matching `+` in counters. */
export const MINUS_SIGN = '−';

/** `1 card`, `3 cards` (`0 cards`); irregular plurals via `plural`. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** `a`, `a and b`, `a, b and c`. */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** The text with its first character upper-cased (UTF-16 based, like `toUpperCase`). */
export function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Length in Unicode code points: the unit user-facing length limits count in. */
export function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length++;
  return length;
}

/** NFC, runs of whitespace collapsed to one space, trimmed: the form of every single-line label. */
export function normalizeInlineText(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** {@link normalizeInlineText} of the lower-cased text, for comparing labels regardless of case and spacing. */
export function foldInlineText(text: string): string {
  return normalizeInlineText(text.toLowerCase());
}

/**
 * `text` itself when it is at most `max` UTF-16 units long, otherwise its first
 * `max - 1` units (without trailing whitespace and without half of a surrogate pair)
 * followed by `…`.
 */
export function truncateWithEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const lastKept = text.charCodeAt(end - 1);
  // A high surrogate at the cut would be left without its low half.
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

/** Bytes as `512 B`, `12.3 KB`, `1.4 MB` (decimal units, as browsers show downloads). */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
