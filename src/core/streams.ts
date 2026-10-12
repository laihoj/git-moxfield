/** Bounded reading of untrusted Web Streams: a body over the limit is abandoned, not buffered. */

/** The bytes of `chunks` (`total` of them in all) as one array. */
function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The bytes of `stream`, or `null` as soon as more than `maxBytes` have arrived (the rest is
 * cancelled; a failing cancel is ignored). A stream that fails while read rejects with its error.
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
