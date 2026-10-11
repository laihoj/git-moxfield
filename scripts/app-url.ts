/**
 * The base URL the command-line scripts print one-time links with: the `--base-url`
 * option, else `PUBLIC_APP_URL`, else the dev server's address.
 */
import { parseHttpUrl } from '@/core/http-url';
import type { AppConfig } from '@/server/config';

/** The base URL when neither `--base-url` nor `PUBLIC_APP_URL` is set. */
export const DEFAULT_APP_URL = 'http://localhost:3000';

/** The base URL to print links with, or `null` when the option (or the setting) is not an absolute http(s) URL. */
export function resolveBaseUrl(option: unknown, config: Pick<AppConfig, 'PUBLIC_APP_URL'>): string | null {
  const value = typeof option === 'string' ? option : (config.PUBLIC_APP_URL ?? DEFAULT_APP_URL);
  return parseHttpUrl(value)?.href ?? null;
}
