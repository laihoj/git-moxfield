/**
 * The text of a page's search parameter (Next.js passes a string, an array when it is
 * repeated, or `undefined`): trimmed, cut to `maxLength`, `undefined` when absent, blank or repeated.
 */
export function searchParamText(value: string | string[] | undefined, maxLength: number): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? undefined : text.slice(0, maxLength);
}
