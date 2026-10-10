/**
 * DNS-rebinding guard: decides from the `Host` (and `X-Forwarded-Host`) header whether a
 * request was addressed to a name git-moxfield answers to. `src/proxy.ts` rejects every
 * other request before it reaches a page, route handler or server action.
 *
 * Why: the app's same-origin checks (the capture endpoint's `Origin` check and Next.js's
 * server-action check) compare `Origin` with the request's own host. A page on
 * `http://rebind.attacker.example:3000` whose DNS name the attacker re-points to
 * 127.0.0.1 is same-origin with that host, so without this guard it could read every
 * page (including the capture token on `/setup`) and call every endpoint. Once the host
 * is known to be one of the app's own names, those same-origin checks are sound.
 *
 * Allowed without configuration: IP literals and `localhost`/`*.localhost`. A browser
 * only sends those as `Host` when it connected without attacker-controlled DNS, so
 * LAN-by-IP use from a phone keeps working. Every other name (mDNS such as
 * `mybox.local`, a reverse proxy's domain) must be the host of `PUBLIC_APP_URL` or be
 * listed in `ALLOWED_HOSTS`. Ports are ignored: rebinding only controls the name.
 *
 * Dependency-free and not `server-only`, so the proxy (which reads the environment
 * directly) and the configuration validation can share it. Pure.
 */
import { isIP } from 'node:net';

interface HeaderSource {
  get(name: string): string | null;
}

/** The environment variables that name additional hosts. */
export interface HostGuardEnv {
  PUBLIC_APP_URL?: string | undefined;
  ALLOWED_HOSTS?: string | undefined;
}

/**
 * The lowercase hostname of a `host[:port]` value as sent in `Host` (IPv6 literals keep
 * their brackets; one trailing dot is dropped), or `null` when the value is malformed,
 * carries anything besides a host and port (userinfo, path, query, fragment), or is not
 * in the canonical form browsers send (percent-escapes, shorthand IPv4 such as `127.1`).
 */
export function hostnameOf(value: string): string | null {
  const host = value.trim().toLowerCase();
  if (host === '') return null;
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return null;
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return null;
  }
  // Nothing may have been decoded, stripped or normalized away by the URL parser.
  const name = host.replace(/:\d+$/, '');
  if (name !== url.hostname) return null;
  return name.endsWith('.') ? name.slice(0, -1) : name;
}

function listEntries(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** `ALLOWED_HOSTS` entries that are not `host[:port]` values (for configuration errors). */
export function invalidAllowedHosts(value: string | undefined): string[] {
  return listEntries(value).filter((entry) => hostnameOf(entry) === null);
}

/**
 * The hostnames configured to reach the app: the host of `PUBLIC_APP_URL` and every
 * `ALLOWED_HOSTS` entry (comma-separated `host[:port]` values). Malformed values are
 * skipped here; the configuration validation reports them.
 */
export function configuredHostnames(env: HostGuardEnv): ReadonlySet<string> {
  const names = new Set<string>();
  const publicUrl = env.PUBLIC_APP_URL?.trim() ?? '';
  if (publicUrl !== '') {
    try {
      const name = hostnameOf(new URL(publicUrl).host);
      if (name !== null) names.add(name);
    } catch {
      // Not a URL: reported by the configuration validation.
    }
  }
  for (const entry of listEntries(env.ALLOWED_HOSTS)) {
    const name = hostnameOf(entry);
    if (name !== null) names.add(name);
  }
  return names;
}

/** Whether git-moxfield answers to `hostname` (as returned by {@link hostnameOf}). */
export function isAllowedHostname(hostname: string, configured: ReadonlySet<string>): boolean {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (isIP(bare) !== 0) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  return configured.has(hostname);
}

/**
 * Whether a request is addressed to git-moxfield: `Host` must be present and allowed,
 * and so must every `X-Forwarded-Host` value. Next.js's server-action check and
 * `requestOrigin()` prefer `X-Forwarded-Host`, so a spoofed one must not slip through.
 */
export function isAllowedRequestHost(headers: HeaderSource, configured: ReadonlySet<string>): boolean {
  const host = headers.get('host');
  if (host === null) return false;
  const forwarded = headers.get('x-forwarded-host');
  const values = forwarded === null ? [host] : [host, ...forwarded.split(',')];
  return values.every((value) => {
    const name = hostnameOf(value);
    return name !== null && isAllowedHostname(name, configured);
  });
}
