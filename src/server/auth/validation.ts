/**
 * Validation of the short texts people type into the account system: display names,
 * bookmarklet key labels and invite notes. Input is normalized (NFC, runs of whitespace
 * collapsed, trimmed) and then accepted or rejected as a whole, never silently altered
 * beyond that, so people see exactly what is stored. Control and invisible formatting
 * characters (e.g. bidirectional overrides, zero-width joiners) are rejected: names are
 * shown to other users, and such characters can make one name look like another.
 */
import 'server-only';

export const MAX_DISPLAY_NAME_LENGTH = 40;
export const MAX_KEY_LABEL_LENGTH = 60;
export const MAX_INVITE_NOTE_LENGTH = 200;

/** Longest User-Agent kept with a session (enough to recognize a browser and device). */
export const MAX_USER_AGENT_LENGTH = 256;

export type TextValidation = { ok: true; value: string } | { ok: false; message: string };

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u;

function normalize(input: unknown): string {
  return typeof input === 'string' ? input.normalize('NFC').replace(/\s+/gu, ' ').trim() : '';
}

function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length++;
  return length;
}

function validate(
  input: unknown,
  rules: { what: string; max: number; required: boolean; emptyMessage: string },
): TextValidation {
  const value = normalize(input);
  if (value === '') return rules.required ? { ok: false, message: rules.emptyMessage } : { ok: true, value };
  if (codePointLength(value) > rules.max) {
    return { ok: false, message: `${rules.what} can be at most ${rules.max} characters long.` };
  }
  if (INVISIBLE.test(value)) {
    return { ok: false, message: `${rules.what} contains characters that cannot be shown.` };
  }
  return { ok: true, value };
}

/** A user's display name: 1–{@link MAX_DISPLAY_NAME_LENGTH} visible characters. */
export function validateDisplayName(input: unknown): TextValidation {
  return validate(input, {
    what: 'Names',
    max: MAX_DISPLAY_NAME_LENGTH,
    required: true,
    emptyMessage: 'Enter a name.',
  });
}

/** A bookmarklet key's label ("Laptop Chrome"): 1–{@link MAX_KEY_LABEL_LENGTH} characters. */
export function validateKeyLabel(input: unknown): TextValidation {
  return validate(input, {
    what: 'Labels',
    max: MAX_KEY_LABEL_LENGTH,
    required: true,
    emptyMessage: 'Name the bookmarklet, e.g. “Laptop Chrome”.',
  });
}

/** An invite's note for admins ("for Mikko"): optional, up to {@link MAX_INVITE_NOTE_LENGTH} characters. */
export function validateInviteNote(input: unknown): TextValidation {
  return validate(input, { what: 'Notes', max: MAX_INVITE_NOTE_LENGTH, required: false, emptyMessage: '' });
}

/**
 * A User-Agent header as stored with a session: control characters removed, truncated
 * to {@link MAX_USER_AGENT_LENGTH} characters, `null` when empty. Untrusted and only
 * ever displayed as text.
 */
export function cleanUserAgent(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (cleaned === '') return null;
  let truncated = '';
  let length = 0;
  for (const codePoint of cleaned) {
    if (length++ === MAX_USER_AGENT_LENGTH) break;
    truncated += codePoint;
  }
  return truncated;
}
