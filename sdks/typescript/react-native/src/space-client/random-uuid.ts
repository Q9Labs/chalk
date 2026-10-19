/**
 * JavaScriptCore on React Native has no Web Crypto, and the client calls `crypto.randomUUID()` for request and command keys.
 * Without it, Leave and media commands fail. The fallback only fills the missing global, so runtimes with Web Crypto keep it.
 */
export function ensureRandomUUID(): void {
  if (typeof globalThis.crypto !== "undefined") return;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { randomUUID } });
}

function randomUUID(): string {
  const hex = (digits: number) => Array.from({ length: digits }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}
