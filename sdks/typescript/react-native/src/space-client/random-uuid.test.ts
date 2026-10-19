import { afterEach, describe, expect, it } from "vitest";
import { ensureRandomUUID } from "./random-uuid";

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");

afterEach(() => {
  if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
  else Reflect.deleteProperty(globalThis, "crypto");
});

describe("ensureRandomUUID", () => {
  it("gives a runtime without Web Crypto a version 4 randomUUID", () => {
    Reflect.deleteProperty(globalThis, "crypto");
    ensureRandomUUID();
    expect(globalThis.crypto.randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("leaves an existing Web Crypto alone", () => {
    const existing = globalThis.crypto;
    ensureRandomUUID();
    expect(globalThis.crypto).toBe(existing);
  });
});
