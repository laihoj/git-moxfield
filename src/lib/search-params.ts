/**
 * Reading the query string of a page, client-safe and pure. Next.js hands a search
 * parameter over as a string, or an array when it is repeated, or `undefined`.
 */

/**
 * The text of a search parameter: trimmed, cut to `maxLength` characters, `undefined`
 * when it is absent, blank or repeated.
 */
export function searchParamText(value: string | string[] | undefined, maxLength: number): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? undefined : text.slice(0, maxLength);
}
