import { describe, expect, it } from "vitest";
import { canEnumerateMediaDevices, enumerateMediaDevices } from "../utils/media-devices";

describe("media device utils", () => {
  it("returns false and empty devices when navigator mediaDevices APIs are unavailable", async () => {
    const originalNavigator = globalThis.navigator;

    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: {},
    });

    try {
      expect(canEnumerateMediaDevices()).toBe(false);
      expect(await enumerateMediaDevices()).toEqual([]);
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        writable: true,
        value: originalNavigator,
      });
    }
  });
});
