import { randomUUID } from "expo-crypto";

/**
 * JavaScriptCore on React Native has no Web Crypto, and the client calls `crypto.randomUUID()` for request and command keys
 * and for its connection id, which must come from a secure source. Without it, Leave and media commands fail. This fills only
 * what is missing with Expo's native secure generator, so runtimes with Web Crypto keep theirs.
 */
export function ensureRandomUUID(): void {
  const existing: Partial<Crypto> | undefined = globalThis.crypto;
  if (typeof existing?.randomUUID === "function") return;
  if (existing === undefined) {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { randomUUID } });
    return;
  }
  // A partial Web Crypto, such as a getRandomValues polyfill, keeps its members and gains randomUUID.
  Object.defineProperty(existing, "randomUUID", { configurable: true, value: randomUUID });
}
