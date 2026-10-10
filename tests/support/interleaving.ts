/**
 * Deterministic interleavings for concurrency tests: repositories that let another
 * instance's work run between two of a service's repository calls.
 *
 * Remotely (Turso), statements outside a transaction each see whatever is committed when
 * they run, so another function instance can change the database between any two of them.
 * {@link interleavedRepositories} reproduces that at repository-call granularity: the
 * `at`-th call made through the returned repositories settles, then `interfere` runs to
 * completion, and only then does the caller see the call's result. Running an operation
 * once for every `at` explores every point at which another instance could act.
 */
import type { Repositories } from '@/server/repositories';

export interface InterleavedRepositories {
  /** Repositories to build the service under test on. */
  readonly repos: Repositories;
  /** Number of repository calls made so far (including transactions). */
  calls(): number;
  /** Whether `interfere` has run (the operation made at least `at` calls). */
  interfered(): boolean;
}

/**
 * Wraps `repos` so that `interfere` runs right after the `at`-th call (1-based) settles,
 * before its caller continues. Calls are numbered in the order they are made. A
 * `transaction` counts as one call: its callback receives unwrapped repositories, since
 * nothing can interleave with a transaction (it holds the database's write lock).
 */
export function interleavedRepositories(
  repos: Repositories,
  at: number,
  interfere: () => Promise<void>,
): InterleavedRepositories {
  let calls = 0;
  let interfered = false;

  const intercept = <T>(start: () => Promise<T>): Promise<T> => {
    calls += 1;
    const position = calls;
    const settled = start();
    if (position !== at) return settled;
    const resume = async (): Promise<void> => {
      interfered = true;
      await interfere();
    };
    return settled.then(
      async (value) => {
        await resume();
        return value;
      },
      async (error: unknown) => {
        await resume();
        throw error;
      },
    );
  };

  const wrapRepository = (repository: object): object =>
    new Proxy(repository, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) =>
          intercept(() => Promise.resolve(Reflect.apply(value, target, args) as unknown));
      },
    });

  const wrapped = Object.fromEntries(
    Object.entries(repos).map(([name, value]) => [
      name,
      typeof value === 'function' ? value : wrapRepository(value as object),
    ]),
  ) as unknown as Repositories;

  return {
    repos: {
      ...wrapped,
      transaction: (fn, options) => intercept(() => repos.transaction(fn, options)),
    },
    calls: () => calls,
    interfered: () => interfered,
  };
}
