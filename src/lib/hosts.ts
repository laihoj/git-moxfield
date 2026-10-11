/**
 * Host names, client-safe and pure: the cookie rules of the server and the bookmarklet
 * instructions in the browser both need to know whether an address only works on the
 * computer that runs git-moxfield.
 */

/**
 * Whether `hostname` (as in `URL.hostname`: lower case, IPv6 literals in brackets) is
 * the loopback host: `localhost`, `*.localhost`, `127.0.0.1` or `[::1]`.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  );
}
