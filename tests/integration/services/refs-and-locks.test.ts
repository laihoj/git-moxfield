import { describe, expect, it } from 'vitest';

import { KeyedMutex } from '@/server/services/mutex';
import { parseVersionRef } from '@/server/services/refs';

describe('parseVersionRef', () => {
  it.each([
    ['v12', { kind: 'sequence', sequence: 12, fallbackPrefix: null }],
    [' V3 ', { kind: 'sequence', sequence: 3, fallbackPrefix: null }],
    ['7', { kind: 'sequence', sequence: 7, fallbackPrefix: null }],
    ['1234', { kind: 'sequence', sequence: 1234, fallbackPrefix: '1234' }],
    ['HEAD', { kind: 'head' }],
    ['working', { kind: 'working' }],
    ['Empty', { kind: 'empty' }],
    ['ABCD12', { kind: 'commit-prefix', prefix: 'abcd12' }],
    ['0000', { kind: 'commit-prefix', prefix: '0000' }],
    ['1234567890', { kind: 'commit-prefix', prefix: '1234567890' }],
  ])('parses %j', (input, expected) => {
    expect(parseVersionRef(input)).toEqual(expected);
  });

  it.each(['', 'v0', '0', 'abc', 'v12a', 'main', 'g123', 'a'.repeat(65), 'v1234567890'])(
    'rejects %j',
    (input) => {
      expect(parseVersionRef(input)).toBeNull();
    },
  );
});

describe('KeyedMutex', () => {
  it('runs tasks for one key one at a time, in order, and other keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = mutex.run('a', async () => {
      events.push('a1 start');
      await firstGate;
      events.push('a1 end');
      return 1;
    });
    const second = mutex.run('a', () => {
      events.push('a2');
      return Promise.resolve(2);
    });
    const other = mutex.run('b', () => {
      events.push('b1');
      return Promise.resolve(3);
    });

    expect(await other).toBe(3);
    expect(mutex.isLocked('a')).toBe(true);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(events).toEqual(['a1 start', 'b1', 'a1 end', 'a2']);
    await Promise.resolve();
    expect(mutex.isLocked('a')).toBe(false);
    expect(mutex.isLocked('b')).toBe(false);
  });

  it('keeps going after a failed task', async () => {
    const mutex = new KeyedMutex();
    const failed = mutex.run('a', () => Promise.reject(new Error('boom')));
    const next = mutex.run('a', () => Promise.resolve('ok'));
    await expect(failed).rejects.toThrow('boom');
    expect(await next).toBe('ok');
  });
});
