/**
 * Runs synchronous work as a promise: thrown errors become rejections, so callers of an
 * async service API never see synchronous throws. The service APIs are asynchronous even
 * though better-sqlite3 is synchronous, so moving to an asynchronous database driver
 * changes their internals only.
 */
export function settle<T>(work: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(work());
  });
}
