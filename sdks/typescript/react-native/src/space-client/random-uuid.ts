import { randomUUID } from "expo-crypto";

/**
 * JavaScriptCore on React Native has no Web Crypto, and the client calls `crypto.randomUUID()` for request and command keys
 * and for its connection id, which must come from a secure source. Without it, Leave and media commands fail. This fills only
 * the missing global with Expo's native secure generator, so runtimes with Web Crypto keep theirs.
 */
export function ensureRandomUUID(): void {
  if (typeof globalThis.crypto !== "undefined") return;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { randomUUID } });
}
