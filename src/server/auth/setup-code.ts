/**
 * The setup code that claims a fresh installation (ADR 0006): while no user exists, the
 * server prints it to its log, and whoever can read the log enters it at `/claim` to
 * become the first admin.
 *
 * Format `XXXX-XXXX-XXXX`: 12 characters from a 29-symbol alphabet without look-alikes
 * (no 0/O, 1/I/L or U/V to misread), drawn uniformly from the CSPRNG by rejection
 * sampling: 29^12 ≈ 2^58 possibilities, far beyond online guessing. Input is forgiving
 * about case, spaces and dashes; comparison is constant-time.
 */
import 'server-only';

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { MAX_SETUP_CODE_INPUT_LENGTH } from '@/core/text-limits';

/** Unambiguous upper-case letters and digits. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ23456789';

const GROUPS = 3;
const GROUP_LENGTH = 4;
const CODE_LENGTH = GROUPS * GROUP_LENGTH;

/** A canonical setup code. */
export const SETUP_CODE_PATTERN = new RegExp(
  `^[${ALPHABET}]{${GROUP_LENGTH}}(?:-[${ALPHABET}]{${GROUP_LENGTH}}){${GROUPS - 1}}$`,
);

/** Largest multiple of the alphabet size that fits in a byte: bytes above it are rejected. */
const UNBIASED_LIMIT = 256 - (256 % ALPHABET.length);

/** A fresh, uniformly random setup code in canonical form. */
export function generateSetupCode(): string {
  const symbols: string[] = [];
  while (symbols.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH * 2)) {
      if (byte >= UNBIASED_LIMIT) continue;
      symbols.push(ALPHABET.charAt(byte % ALPHABET.length));
      if (symbols.length === CODE_LENGTH) break;
    }
  }
  return group(symbols.join(''));
}

/**
 * The canonical form of a typed setup code (case, spaces and dashes ignored), or `null`
 * when it cannot be a setup code.
 */
export function normalizeSetupCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > MAX_SETUP_CODE_INPUT_LENGTH) return null;
  const compact = input.toUpperCase().replace(/[\s-]+/g, '');
  if (compact.length !== CODE_LENGTH) return null;
  for (const symbol of compact) if (!ALPHABET.includes(symbol)) return null;
  return group(compact);
}

/**
 * Whether two setup codes are equal, in constant time (both are reduced to SHA-256
 * digests first, so neither content nor length leaks through timing).
 */
export function setupCodesEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function group(compact: string): string {
  const groups: string[] = [];
  for (let i = 0; i < compact.length; i += GROUP_LENGTH) groups.push(compact.slice(i, i + GROUP_LENGTH));
  return groups.join('-');
}

function digest(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}
