/**
 * Promise plumbing for tests that control when something finishes.
 */

/** A promise and the function that resolves it, for a test to settle at the moment it chooses. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
