import { describe, expect, it, vi } from 'vitest';

import { sharedWriteLock, WriteLock, WriteLockError } from './write-lock';

/** A promise plus the function that resolves it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Lets every pending microtask and immediate run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('WriteLock', () => {
  it('runs one task at a time and returns each result', async () => {
    const lock = new WriteLock('test');
    let running = 0;
    let maxRunning = 0;
    const task = async (value: number): Promise<number> => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await settle();
      running--;
      return value;
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map((value) => lock.run(() => task(value))));
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(maxRunning).toBe(1);
    expect(lock.locked).toBe(false);
  });

  it('grants the lock in request order (FIFO), also to tasks queued while it is handed over', async () => {
    const lock = new WriteLock('test');
    const order: string[] = [];
    const first = deferred();
    const push = (name: string) => () => {
      order.push(name);
    };
    const holder = lock.run(async () => {
      order.push('holder');
      await first.promise;
    });
    const queued = [lock.run(push('a')), lock.run(push('b')), lock.run(push('c'))];
    expect(lock.queueLength).toBe(3);
    first.resolve();
    // Queued after the holder was told to finish, before it released the lock.
    const late = lock.run(push('late'));
    await Promise.all([holder, ...queued, late]);
    expect(order).toEqual(['holder', 'a', 'b', 'c', 'late']);
  });

  it('never lets a newcomer overtake waiting tasks (no starvation)', async () => {
    const lock = new WriteLock('test');
    const order: string[] = [];
    const gate = deferred();
    const holder = lock.run(() => gate.promise);
    const waiter = lock.run(() => {
      order.push('waiter');
    });
    gate.resolve();
    // Arrives after the release was triggered but before the waiter ran.
    const newcomer = lock.run(() => {
      order.push('newcomer');
    });
    await Promise.all([holder, waiter, newcomer]);
    expect(order).toEqual(['waiter', 'newcomer']);
  });

  it('releases the lock when a task fails and propagates the error', async () => {
    const lock = new WriteLock('test');
    const failure = new Error('boom');
    await expect(lock.run(() => Promise.reject(failure))).rejects.toBe(failure);
    await expect(
      lock.run(() => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(lock.run(() => 'next')).resolves.toBe('next');
    expect(lock.locked).toBe(false);
  });

  it('rejects a nested run from the holding context at once instead of deadlocking', async () => {
    const lock = new WriteLock('the test database');
    const nested = await lock.run(async () => {
      expect(lock.isHeldByCurrentContext()).toBe(true);
      // Also deep inside other async functions.
      const inner = async (): Promise<unknown> => {
        await settle();
        return lock.run(() => 'never').catch((error: unknown) => error);
      };
      return inner();
    });
    expect(nested).toBeInstanceOf(WriteLockError);
    expect(nested).toMatchObject({ code: 'reentrant' });
    expect((nested as Error).message).toContain('the test database');
    expect(lock.isHeldByCurrentContext()).toBe(false);
  });

  it('does not treat work that outlives its task as holding the lock', async () => {
    const lock = new WriteLock('test');
    const later = deferred();
    let afterwards: Promise<string> | undefined;
    await lock.run(() => {
      setTimeout(() => {
        afterwards = lock.run(() => 'ran after the task settled');
        later.resolve();
      }, 1);
    });
    await later.promise;
    await expect(afterwards).resolves.toBe('ran after the task settled');
  });

  it('still counts as held when a lazy thenable returned by the task runs', async () => {
    // Drizzle query builders only execute when awaited, which happens after `task` returned.
    const lock = new WriteLock('test');
    const lazy = {
      then(resolve: (held: boolean) => void): void {
        resolve(lock.isHeldByCurrentContext());
      },
    };
    await expect(lock.run(() => lazy as unknown as Promise<boolean>)).resolves.toBe(true);
  });

  it('lets different locks nest', async () => {
    const outer = new WriteLock('outer');
    const inner = new WriteLock('inner');
    const result = await outer.run(() =>
      inner.run(() => outer.isHeldByCurrentContext() && inner.isHeldByCurrentContext()),
    );
    expect(result).toBe(true);
  });

  it('times out a waiter without disturbing the queue behind it', async () => {
    vi.useFakeTimers();
    try {
      const lock = new WriteLock('the slow database');
      const gate = deferred();
      const holder = lock.run(() => gate.promise);
      const impatient = lock.run(() => 'impatient', { timeoutMs: 100 });
      const patient = lock.run(() => 'patient');
      const outcome = impatient.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);
      const error = await outcome;
      expect(error).toBeInstanceOf(WriteLockError);
      expect(error).toMatchObject({ code: 'timeout' });
      expect((error as Error).message).toContain('100 ms');
      expect((error as Error).message).toContain('the slow database');
      expect(lock.queueLength).toBe(1);
      gate.resolve();
      await holder;
      await expect(patient).resolves.toBe('patient');
      expect(lock.locked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not time out a waiter that got the lock in time', async () => {
    const lock = new WriteLock('test');
    const gate = deferred();
    const holder = lock.run(() => gate.promise);
    const waiter = lock.run(() => 'granted', { timeoutMs: 50 });
    gate.resolve();
    await holder;
    await expect(waiter).resolves.toBe('granted');
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(lock.locked).toBe(false);
  });
});

describe('sharedWriteLock', () => {
  it('returns one lock per key for the whole process', () => {
    const a = sharedWriteLock('file:/tmp/a.db');
    expect(sharedWriteLock('file:/tmp/a.db')).toBe(a);
    expect(sharedWriteLock('file:/tmp/b.db')).not.toBe(a);
    expect(a.name).toBe('file:/tmp/a.db');
  });

  it('survives a fresh module instance (dev-server HMR)', async () => {
    const before = sharedWriteLock('file:/tmp/hmr.db');
    vi.resetModules();
    const reloaded = await import('./write-lock');
    expect(reloaded.sharedWriteLock).not.toBe(sharedWriteLock);
    expect(reloaded.sharedWriteLock('file:/tmp/hmr.db')).toBe(before);
  });

  it('recognizes its holder across module instances', async () => {
    const lock = sharedWriteLock('file:/tmp/hmr-holder.db');
    vi.resetModules();
    const reloaded = await import('./write-lock');
    await lock.run(async () => {
      const again = reloaded.sharedWriteLock('file:/tmp/hmr-holder.db');
      expect(again.isHeldByCurrentContext()).toBe(true);
      await expect(again.run(() => undefined)).rejects.toMatchObject({ code: 'reentrant' });
    });
  });
});
