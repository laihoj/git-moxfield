/**
 * Version tags (`tournament`, `pre-ban`): the one rule for what a tag is. The repository
 * enforces it; the tag editors show a tag the way it will be stored and explain a refusal.
 */
import { codePointLength, foldInlineText } from './text';

/** Maximum tag length in Unicode code points (after normalization). */
export const MAX_VERSION_TAG_LENGTH = 40;

type VersionTagValidation = { ok: true; name: string } | { ok: false; reason: string };

/** What someone typed into a tag field: nothing, a tag that cannot be used, or the tag to store. */
type TagDraft = { kind: 'empty' } | { kind: 'invalid'; problem: string } | { kind: 'ok'; tag: string };

const ALLOWED_TAG = /^[\p{L}\p{M}\p{N} ._-]+$/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Reads a tag field's text: normalized the way it will be stored, and checked. */
export function parseTagDraft(raw: string): TagDraft {
  const tag = foldInlineText(raw);
  if (tag === '') return { kind: 'empty' };
  const problem = tagProblem(tag);
  return problem === null ? { kind: 'ok', tag } : { kind: 'invalid', problem };
}

/** A reason why `tag` (already normalized) is not a valid tag, or `null` when it is. */
function tagProblem(tag: string): string | null {
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
 * The tag `input` names (lower case, NFC, whitespace collapsed, trimmed), or why it is
 * refused: invalid input is never silently altered, so people see exactly what is stored.
 */
export function normalizeVersionTag(input: string): VersionTagValidation {
  const name = foldInlineText(input);
  const problem = tagProblem(name);
  return problem === null ? { ok: true, name } : { ok: false, reason: problem };
}
