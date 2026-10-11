/**
 * Per-process state that must survive module reloads. A module-level `const` does not:
 * the dev server's hot reloads re-evaluate modules, and Next.js builds more than one
 * module graph, so each would get a state of its own. These helpers keep the state on
 * `globalThis` under a symbol from the global registry (`Symbol.for`).
 */
import 'server-only';

/**
 * Returns the process-wide value stored under `key`, creating it on first use. For locks,
 * async-local storages, registries and other state that every module instance must share.
 */
export function processSingleton<T>(key: symbol, create: () => T): T {
  const store = globalThis as unknown as Record<symbol, T | undefined>;
  store[key] ??= create();
  return store[key];
}

/** Whether this is the first call with `key` in the process: for things to announce once. */
export function firstTimeInProcess(key: symbol): boolean {
  const store = globalThis as unknown as Record<symbol, true | undefined>;
  if (store[key] === true) return false;
  store[key] = true;
  return true;
}
