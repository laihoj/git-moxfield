/**
 * Parsing of user-facing version references (`compare?from=v3&to=working`).
 *
 * Accepted (case-insensitive, surrounding whitespace ignored):
 *   `v12`, `12`   version by sequence
 *   `head`        latest version
 *   `working`     latest observed Moxfield state (uncommitted)
 *   `empty`       the empty deck
 *   4–64 hex      commit id prefix (unique within the deck)
 *
 * A bare number of four or more digits is also a valid hex prefix; the resolver tries
 * it as a sequence first and falls back to the prefix (see {@link ParsedVersionRef}).
 */
import { MIN_COMMIT_ID_PREFIX_LENGTH } from '@/server/repositories';

export type ParsedVersionRef =
  | {
      kind: 'sequence';
      sequence: number;
      /** The same text as a commit id prefix, when it is one (bare numbers of 4+ digits). */
      fallbackPrefix: string | null;
    }
  | { kind: 'head' }
  | { kind: 'working' }
  | { kind: 'empty' }
  | { kind: 'commit-prefix'; prefix: string };

/** Longest sequence accepted; far beyond any real deck history. */
const MAX_SEQUENCE_DIGITS = 9;

const HEX_PREFIX = new RegExp(`^[0-9a-f]{${MIN_COMMIT_ID_PREFIX_LENGTH},64}$`);

/** Parses a version reference, or returns `null` when it has none of the accepted forms. */
export function parseVersionRef(ref: string): ParsedVersionRef | null {
  const text = ref.trim().toLowerCase();
  if (text === 'head' || text === 'working' || text === 'empty') return { kind: text };

  const sequenceMatch = /^(v?)(\d+)$/.exec(text);
  if (sequenceMatch) {
    const [, v = '', digits = ''] = sequenceMatch;
    const fallbackPrefix = v === '' && HEX_PREFIX.test(digits) ? digits : null;
    const sequence = Number(digits);
    if (digits.length <= MAX_SEQUENCE_DIGITS && sequence >= 1) {
      return { kind: 'sequence', sequence, fallbackPrefix };
    }
    return fallbackPrefix === null ? null : { kind: 'commit-prefix', prefix: fallbackPrefix };
  }

  return HEX_PREFIX.test(text) ? { kind: 'commit-prefix', prefix: text } : null;
}
