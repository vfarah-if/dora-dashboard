/** The chunks of a stream joined, in order, into one array of `size` bytes, which their lengths must sum to. */
export function joinBytes(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}
