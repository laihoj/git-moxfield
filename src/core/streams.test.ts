import { describe, expect, it } from 'vitest';

import { concatBytes, readStreamLimited } from './streams';

function streamOf(...chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
  });
}

describe('concatBytes', () => {
  it('joins chunks in order', () => {
    expect(concatBytes([Uint8Array.of(1, 2), Uint8Array.of(), Uint8Array.of(3)], 3)).toEqual(
      Uint8Array.of(1, 2, 3),
    );
  });

  it('is empty without chunks', () => {
    expect(concatBytes([], 0)).toEqual(new Uint8Array());
  });
});

describe('readStreamLimited', () => {
  it('reads a stream that fits the limit', async () => {
    expect(await readStreamLimited(streamOf([1, 2], [3, 4, 5]), 5)).toEqual(Uint8Array.of(1, 2, 3, 4, 5));
  });

  it('reads an empty stream', async () => {
    expect(await readStreamLimited(streamOf(), 0)).toEqual(new Uint8Array());
  });

  it('returns null as soon as the stream exceeds the limit, and cancels it', async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await readStreamLimited(stream, 7)).toBeNull();
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(5);
  });

  it('returns null even when cancelling the stream fails', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        return Promise.reject(new Error('cancel failed'));
      },
    });
    expect(await readStreamLimited(stream, 7)).toBeNull();
  });

  it('rejects with the error of a stream that fails while it is read', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2));
        controller.error(new Error('broken'));
      },
    });
    await expect(readStreamLimited(stream, 7)).rejects.toThrow('broken');
  });
});
