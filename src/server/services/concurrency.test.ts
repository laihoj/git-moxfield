import { describe, expect, it } from 'vitest';

import { mapConcurrently } from './concurrency';

/** A promise with its resolve function exposed. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('mapConcurrently', () => {
  it('returns the results in the order of the items, whatever order they finish in', async () => {
    const delays = [30, 0, 10, 20];
    const results = await mapConcurrently(
      delays,
      (ms, index) =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve(`${index}:${ms}`);
          }, ms);
        }),
      2,
    );
    expect(results).toEqual(['0:30', '1:0', '2:10', '3:20']);
  });

  it('runs at most `limit` calls at a time and starts the next as soon as one finishes', async () => {
    const gates = Array.from({ length: 5 }, () => deferred<undefined>());
    const started: number[] = [];
    const running = mapConcurrently(
      gates,
      async (gate, index) => {
        started.push(index);
        await gate.promise;
        return index;
      },
      2,
    );
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    gates[1]?.resolve(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1, 2]);
    for (const gate of gates) gate.resolve(undefined);
    expect(await running).toEqual([0, 1, 2, 3, 4]);
  });

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapConcurrently([], () => Promise.resolve(1))).toEqual([]);
    expect(await mapConcurrently([1, 2], (n) => Promise.resolve(n * 2), 10)).toEqual([2, 4]);
  });

  it('rejects with the first failure and starts nothing after it', async () => {
    const started: number[] = [];
    const failure = new Error('boom');
    await expect(
      mapConcurrently(
        [0, 1, 2, 3],
        (n) => {
          started.push(n);
          return n === 1 ? Promise.reject(failure) : Promise.resolve(n);
        },
        1,
      ),
    ).rejects.toBe(failure);
    expect(started).toEqual([0, 1]);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses the limit %s', async (limit) => {
    await expect(mapConcurrently([1], (n) => Promise.resolve(n), limit)).rejects.toThrow(RangeError);
  });
});
