import { sha256 } from "@noble/hashes/sha2.js";
import type { FlagMap } from "./registry.ts";

const FLAG_KEY = /^[a-z][a-z0-9_.]*$/;

// Canonical flags JSON: keys sorted, no whitespace, values limited to strings, booleans, null and safe integers,
// so TypeScript, Go and Elixir produce the same bytes and the same flags_hash.
export function canonicalFlags(flags: FlagMap): string {
  const keys = Object.keys(flags).sort();
  const members = keys.map((key) => {
    if (!FLAG_KEY.test(key)) throw new RangeError(`flag key ${JSON.stringify(key)} must be lower snake_case with dots`);
    const value = flags[key];
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new RangeError(`flag ${key} must be an integer, not ${value}`);
    return `${JSON.stringify(key)}:${JSON.stringify(value ?? null)}`;
  });
  return `{${members.join(",")}}`;
}

// flags_hash: 16 hex characters of the SHA-256 of the canonical flags JSON. Synchronous, because Web Crypto's digest is
// async and flags_hash is stamped on every record; @noble/hashes is already in the call bundle for the Sync reducer.
export function flagsHash(flags: FlagMap): string {
  const digest = sha256(new TextEncoder().encode(canonicalFlags(flags)));
  return Array.from(digest.subarray(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
