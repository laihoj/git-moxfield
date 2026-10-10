/**
 * Client-side preview of version tag normalization, so the UI shows a tag the way it
 * will be stored (`  Pre Ban ` → `pre ban`). The server re-validates every tag and is
 * the authority on what is accepted.
 */

/** Same length limit the server enforces. */
export const MAX_TAG_LENGTH = 40;

/** Lowercase, NFC, whitespace runs collapsed, trimmed. */
export function normalizeTagInput(input: string): string {
  return input.toLowerCase().normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** A reason why `tag` (already normalized) will be rejected, or `null` when it looks valid. */
export function tagProblem(tag: string): string | null {
  if (tag === '') return 'Enter a tag.';
  if (codePointLength(tag) > MAX_TAG_LENGTH) return `Tags can be at most ${MAX_TAG_LENGTH} characters long.`;
  if (!/^[\p{L}\p{M}\p{N} ._-]+$/u.test(tag) || !/[\p{L}\p{N}]/u.test(tag)) {
    return 'Tags may contain letters, digits, spaces, ".", "-" and "_".';
  }
  return null;
}

/** Length in Unicode code points, the unit the server's tag length limit uses. */
function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length++;
  return length;
}
