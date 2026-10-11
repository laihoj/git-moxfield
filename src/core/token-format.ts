/**
 * The format of the account system's tokens (see `src/server/auth/tokens.ts`): a type
 * prefix plus 32 random bytes, base64url without padding (43 characters). Dependency-free,
 * so code that must not import server-only modules (the proxy, the capture protocol the
 * browser shares) can recognize a token's shape.
 */

/** Type prefixes. `share` (`gmv_`, read-only share links) is used by ADR 0007's viewer scope. */
export const TOKEN_PREFIXES = {
  key: 'gmk_',
  session: 'gms_',
  invite: 'gmi_',
  login: 'gml_',
  share: 'gmv_',
} as const;

export type TokenKind = keyof typeof TOKEN_PREFIXES;

/** base64url of 32 bytes, unpadded. */
const TOKEN_BODY_PATTERN = '[A-Za-z0-9_-]{43}';
const TOKEN_BODY = new RegExp(`^${TOKEN_BODY_PATTERN}$`);

/** The whole-token pattern of `kind`: its prefix and a body (`/^gmk_[A-Za-z0-9_-]{43}$/` for a key). */
export function tokenPattern(kind: TokenKind): RegExp {
  return new RegExp(`^${TOKEN_PREFIXES[kind]}${TOKEN_BODY_PATTERN}$`);
}

/**
 * `value` when it is a well-formed token of `kind`, otherwise `null`. Accepts any input
 * (form fields, cookies, JSON) and never throws.
 */
export function parseToken(kind: TokenKind, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const prefix = TOKEN_PREFIXES[kind];
  if (!value.startsWith(prefix)) return null;
  return TOKEN_BODY.test(value.slice(prefix.length)) ? value : null;
}
