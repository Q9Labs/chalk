import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AVATAR_GRADIENT_STORAGE_KEY, DEFAULT_AVATAR_GRADIENT_PREFERENCE, getAvatarInitials, getAvatarSeed, readStoredAvatarGradientPreference, resolveAvatarGradient, sanitizeAvatarGradientPreference } from "./avatarGradient";

const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;

function createStorageMock() {
  const values = new Map<string, string>();

  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
  };
}

describe("avatarGradient", () => {
  let storage: ReturnType<typeof createStorageMock>;

  beforeEach(() => {
    storage = createStorageMock();

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: storage },
      writable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
      writable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
      writable: true,
    });
  });

  it("prefers the saved display name when deriving the avatar seed", () => {
    expect(getAvatarSeed("Hasan Shoaib", "hasan@q9labs.ai")).toBe("Hasan Shoaib");
    expect(getAvatarSeed("", "hasan@q9labs.ai")).toBe("hasan@q9labs.ai");
  });

  it("builds initials from names and email fallbacks", () => {
    expect(getAvatarInitials("Hasan Shoaib")).toBe("HS");
    expect(getAvatarInitials("hasan@q9labs.ai")).toBe("HA");
  });

  it("returns a stable derived palette for the same seed", () => {
    expect(resolveAvatarGradient("Hasan Shoaib")).toEqual(resolveAvatarGradient("Hasan Shoaib"));
  });

  it("keeps valid preset gradients and drops malformed stored values", () => {
    expect(
      sanitizeAvatarGradientPreference({
        mode: "preset",
        presetId: "mint",
      }),
    ).toEqual({
      mode: "preset",
      presetId: "mint",
    });

    expect(
      sanitizeAvatarGradientPreference({
        mode: "preset",
        presetId: "unknown",
      }),
    ).toEqual(DEFAULT_AVATAR_GRADIENT_PREFERENCE);
  });

  it("reads stored preferences from localStorage safely", () => {
    storage.setItem(
      AVATAR_GRADIENT_STORAGE_KEY,
      JSON.stringify({
        mode: "preset",
        presetId: "orchid",
      }),
    );

    expect(readStoredAvatarGradientPreference()).toEqual({
      mode: "preset",
      presetId: "orchid",
    });
  });
});
