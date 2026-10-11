/**
 * Helpers for Web Streams, which servers, the browser and the Moxfield client all read
 * untrusted data from: bounded reading, so that a body larger than a limit is abandoned
 * instead of buffered whole.
 */

/** The bytes of `chunks` (`total` of them in all) as one array. */
export function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Reads `stream` to its end, counting bytes as they arrive. Returns the bytes, or `null`
 * as soon as more than `maxBytes` have arrived (the rest of the stream is cancelled; a
 * failing cancel changes nothing, the stream is abandoned either way). A stream that
 * fails while it is read rejects with its error.
 */
export async function readStreamLimited(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return concatBytes(chunks, total);
}
