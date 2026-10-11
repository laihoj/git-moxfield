/**
 * Version tags (`tournament`, `stable`, `pre-ban`): the one rule for what a tag is. The
 * repository enforces it; the tag editors run the same functions to show a tag the way it
 * will be stored (`  Pre Ban ` becomes `pre ban`) and to explain a refusal before sending.
 */
import { codePointLength, normalizeInlineText } from './text';

/** Maximum tag length in Unicode code points (after normalization). */
export const MAX_VERSION_TAG_LENGTH = 40;

export type VersionTagValidation = { ok: true; name: string } | { ok: false; reason: string };

const ALLOWED_TAG = /^[\p{L}\p{M}\p{N} ._-]+$/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Lowercase, NFC, whitespace runs collapsed to one space, trimmed. */
export function normalizeTagInput(input: string): string {
  return normalizeInlineText(input.toLowerCase());
}

/** A reason why `tag` (already normalized) is not a valid tag, or `null` when it is. */
export function tagProblem(tag: string): string | null {
  if (tag === '') return 'Enter a tag.';
  if (codePointLength(tag) > MAX_VERSION_TAG_LENGTH) {
    return `Tags can be at most ${MAX_VERSION_TAG_LENGTH} characters long.`;
  }
  if (!ALLOWED_TAG.test(tag) || !HAS_LETTER_OR_DIGIT.test(tag)) {
    return 'Tags may contain letters, digits, spaces, ".", "-" and "_".';
  }
  return null;
}

/**
 * Normalizes user input into a tag name (see {@link normalizeTagInput}). A valid tag has
 * 1–{@link MAX_VERSION_TAG_LENGTH} characters from: letters and digits of any script (with
 * combining marks), space, `.`, `-` and `_`, and at least one letter or digit. Invalid
 * input is rejected rather than silently altered, so the user sees exactly the tag that
 * is stored.
 */
export function normalizeVersionTag(input: string): VersionTagValidation {
  const name = normalizeTagInput(input);
  const problem = tagProblem(name);
  return problem === null ? { ok: true, name } : { ok: false, reason: problem };
}
