/** Host names, client-safe: for the server's cookie rules and the browser's bookmarklet instructions. */

/**
 * Whether `hostname` (a `URL.hostname`: lower case, IPv6 in brackets) is the loopback host:
 * `localhost`, `*.localhost`, `127.0.0.1` or `[::1]`.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  );
}
