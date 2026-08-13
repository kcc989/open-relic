/**
 * One allocation and one pass, for the places that know every part up front.
 *
 * Not for the streaming readers: `PackStream` and `PktLineReader` grow a buffer
 * as bytes arrive and have no list to join, which is a different problem with a
 * different answer.
 */
export const concat = (...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));

  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }

  return joined;
};
