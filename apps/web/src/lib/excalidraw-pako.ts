import { strFromU8, strToU8, unzlibSync, zlibSync } from "fflate";

// Excalidraw 0.18 imports pako only to deflate the scene it embeds in exported PNG and SVG files and to inflate it
// back. The hosted app resolves Excalidraw's "pako" to this module: fflate writes and reads the same zlib stream in
// about a fifth of pako's bytes, which every board load pays for.
type Input = string | Uint8Array | ArrayBuffer;

const toBytes = (input: Input) => (typeof input === "string" ? strToU8(input) : input instanceof Uint8Array ? input : new Uint8Array(input));

export function deflate(input: Input): Uint8Array {
  return zlibSync(toBytes(input));
}

const ADLER_MODULUS = 65521;
// The largest run of bytes whose sums stay exact before they are reduced, as in zlib.
const ADLER_RUN = 5552;

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let start = 0; start < bytes.length; start += ADLER_RUN) {
    for (const byte of bytes.subarray(start, start + ADLER_RUN)) {
      a += byte;
      b += a;
    }
    a %= ADLER_MODULUS;
    b %= ADLER_MODULUS;
  }
  return ((b << 16) | a) >>> 0;
}

export function inflate(input: Input, options: { to: "string" }): string;
export function inflate(input: Input): Uint8Array;
export function inflate(input: Input, options?: { to: "string" }): string | Uint8Array {
  const compressed = toBytes(input);
  const bytes = unzlibSync(compressed);
  // fflate skips the Adler-32 trailer; pako rejects a stream whose trailer disagrees, so a corrupted scene never loads.
  const trailer = new DataView(compressed.buffer, compressed.byteOffset + compressed.byteLength - 4, 4).getUint32(0);
  if (trailer !== adler32(bytes)) throw new Error("incorrect data check");
  return options?.to === "string" ? strFromU8(bytes) : bytes;
}
