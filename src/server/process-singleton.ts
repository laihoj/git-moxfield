/** Per-process state on `globalThis`: it survives dev-server reloads and is shared by every module graph. */
import 'server-only';

/**
 * Returns the process-wide value stored under `key` (a `Symbol.for` key), creating it on
 * first use: for locks, async-local storages and registries every module instance must share.
 */
export function processSingleton<T>(key: symbol, create: () => T): T {
  const store = globalThis as unknown as Record<symbol, T | undefined>;
  store[key] ??= create();
  return store[key];
}
