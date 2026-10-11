/** A queue that runs asynchronous tasks one at a time, in the order they were added. Dependency-free. */
export class SerialQueue {
  /** Settles after the last queued task; never rejects. */
  #tail: Promise<unknown> = Promise.resolve();

  /**
   * Runs `task` once every task queued before it has settled, and returns its result. A
   * failing task does not affect the tasks queued after it.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
