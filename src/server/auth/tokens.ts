/**
 * The secrets of the account system (ADR 0006, ADR 0007): bookmarklet keys, session
 * tokens, and invite, login and share link tokens.
 *
 * Every token is a type prefix plus 32 bytes (256 bits) from the operating system's
 * CSPRNG, base64url-encoded without padding: `gmk_` + 43 characters. The prefix makes a
 * leaked token recognizable (and findable by secret scanners), and keeps one kind of
 * token from ever being accepted where another kind is expected.
 *
 * Only {@link hashToken} — the SHA-256 hex digest of the full token string — is stored.
 * A high-entropy secret needs no salt or slow hash: finding a token from its hash is as
 * hard as guessing the token. Lookups go by hash through a unique index, so the database
 * compares hashes, never secrets, and no constant-time comparison is needed there.
 *
 * Tokens from requests are untrusted: `parseToken` (`@/core/token-format`) checks the exact
 * format before any database lookup, so malformed input never reaches SQL.
 */
import 'server-only';

import { randomBytes } from 'node:crypto';

import { sha256Hex } from '@/core/hash';
import { TOKEN_PREFIXES, type TokenKind } from '@/core/token-format';

export { parseToken, TOKEN_PREFIXES, type TokenKind } from '@/core/token-format';

/** Random bytes per token. */
const TOKEN_BYTES = 32;

/** A fresh token of the given kind. */
export function generateToken(kind: TokenKind): string {
  return TOKEN_PREFIXES[kind] + randomBytes(TOKEN_BYTES).toString('base64url');
}

/** SHA-256 hex digest of the full token string: the only form in which tokens are stored. */
export function hashToken(token: string): string {
  return sha256Hex(token);
}
