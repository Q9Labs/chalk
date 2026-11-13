import { strFromU8, strToU8, unzlibSync, zlibSync } from "fflate";

// Excalidraw 0.18 imports pako only to deflate the scene it embeds in exported PNG and SVG files and to inflate it
// back. The hosted app resolves Excalidraw's "pako" to this module: fflate writes and reads the same zlib stream in
// about a fifth of pako's bytes, which every board load pays for.
type Input = string | Uint8Array | ArrayBuffer;

const toBytes = (input: Input) => (typeof input === "string" ? strToU8(input) : input instanceof Uint8Array ? input : new Uint8Array(input));

export function deflate(input: Input): Uint8Array {
  return zlibSync(toBytes(input));
}

export function inflate(input: Input, options: { to: "string" }): string;
export function inflate(input: Input): Uint8Array;
export function inflate(input: Input, options?: { to: "string" }): string | Uint8Array {
  const bytes = unzlibSync(toBytes(input));
  return options?.to === "string" ? strFromU8(bytes) : bytes;
}
