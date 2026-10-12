/** Absolute http(s) URLs: the app's base URLs (its own, Moxfield's API and site). Dependency-free. */

/** The absolute http(s) URL `value` names; `null` for unparseable text and for any other scheme. */
export function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** `path` on the app at `appUrl`. @throws {TypeError} unless `appUrl` is an absolute http(s) URL. */
export function absoluteAppUrl(path: string, appUrl: string): string {
  const base = parseHttpUrl(appUrl);
  if (base === null) throw new TypeError('The app URL must be an absolute http(s) URL');
  return new URL(path, base).href;
}

/** `text` without its trailing slashes. */
export function stripTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '/') end--;
  return text.slice(0, end);
}
