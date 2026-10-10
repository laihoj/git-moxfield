/**
 * Facts about the platform the process runs on that change the app's defaults (ADR 0008).
 * Dependency-free, so that the configuration, the database client and the scripts can all
 * ask the same question the same way.
 */

/** An environment to inspect, such as `process.env`. */
export type PlatformEnv = Readonly<Record<string, string | undefined>>;

/**
 * Whether the process runs on Netlify's servers: in a build (`NETLIFY=true`) or in a
 * function (`SITE_ID`; Netlify documents `NETLIFY` as a build variable only, while
 * functions see `SITE_ID`, `SITE_NAME` and `URL`). `netlify dev` (`NETLIFY_DEV=true`) is
 * a local emulation, not a deploy.
 */
export function runsOnNetlify(env: PlatformEnv = process.env): boolean {
  if (env.NETLIFY_DEV === 'true') return false;
  return env.NETLIFY === 'true' || (env.SITE_ID !== undefined && env.SITE_ID !== '');
}
