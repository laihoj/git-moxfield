import { describe, expect, it } from 'vitest';

import { SerialQueue } from './serial-queue';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('SerialQueue', () => {
  it('starts a task only after the previous one settled, in order', async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    const gate = deferred();
    const first = queue.run(async () => {
      log.push('first start');
      await gate.promise;
      log.push('first end');
      return 1;
    });
    const second = queue.run(() => {
      log.push('second');
      return Promise.resolve(2);
    });
    await Promise.resolve();
    expect(log).toEqual(['first start']);
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(log).toEqual(['first start', 'first end', 'second']);
  });

  it('keeps going after a task fails, and still reports the failure to its caller', async () => {
    const queue = new SerialQueue();
    const failing = queue.run(() => Promise.reject(new Error('boom')));
    const after = queue.run(() => Promise.resolve('still runs'));
    await expect(failing).rejects.toThrow('boom');
    expect(await after).toBe('still runs');
  });
});
