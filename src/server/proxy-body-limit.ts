/**
 * How many bytes of a request body Next.js buffers for `src/proxy.ts`.
 *
 * Because the app has a proxy, Next buffers every request body for it and silently
 * truncates bodies longer than this (`experimental.proxyClientMaxBodySize`, which
 * `next.config.ts` sets from this constant) instead of rejecting them. The capture
 * routes derive their own body limits from it (`src/app/api/capture/read-body.ts`).
 *
 * Deliberately dependency-free and not `server-only`: `next.config.ts` imports it.
 */
export const PROXY_BODY_BUFFER_LIMIT = 24 * 1024 * 1024;
