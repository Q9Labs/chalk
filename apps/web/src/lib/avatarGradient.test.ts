import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AVATAR_GRADIENT_PRESETS,
  DEFAULT_AVATAR_GRADIENT_PREFERENCE,
  getAvatarGradientCss,
  getAvatarInitials,
  getAvatarSeed,
  notifyUserSettingsUpdated,
  readStoredAvatarGradientPreference,
  readStoredDisplayName,
  resolveAvatarGradient,
  sanitizeAvatarGradientPreference,
  writeStoredAvatarGradientPreference,
} from "./avatarGradient";

const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;

function createStorageMock() {
  const values = new Map<string, string>();

  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    clear: vi.fn(() => {
      values.clear();
    }),
  };
}

function installBrowserEnv(storage = createStorageMock()) {
  const dispatchEvent = vi.fn();
  const windowMock = { localStorage: storage, dispatchEvent };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
    writable: true,
  });

  return { dispatchEvent, storage, windowMock };
}

function installServerEnv() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: undefined,
    writable: true,
  });
}

describe("avatarGradient", () => {
  let browser: ReturnType<typeof installBrowserEnv>;

  beforeEach(() => {
    browser = installBrowserEnv();
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
    vi.restoreAllMocks();
  });

  describe("getAvatarSeed", () => {
    it("prefers a trimmed display name over the fallback", () => {
      expect(getAvatarSeed("  Hasan Shoaib  ", "hasan@q9labs.ai")).toBe("Hasan Shoaib");
    });

    it("uses a trimmed fallback when display name is blank", () => {
      expect(getAvatarSeed("   ", "  fallback@example.com  ")).toBe("fallback@example.com");
      expect(getAvatarSeed(undefined, "  fallback@example.com  ")).toBe("fallback@example.com");
    });

    it("falls back to Chalk User when both values are blank", () => {
      expect(getAvatarSeed("   ", "   ")).toBe("Chalk User");
      expect(getAvatarSeed(undefined, undefined)).toBe("Chalk User");
    });
  });

  describe("getAvatarInitials", () => {
    it("returns CU for missing or blank values", () => {
      expect(getAvatarInitials()).toBe("CU");
      expect(getAvatarInitials("")).toBe("CU");
      expect(getAvatarInitials("   ")).toBe("CU");
    });

    it("builds initials from split names and limits them to two characters", () => {
      expect(getAvatarInitials("Hasan Shoaib")).toBe("HS");
      expect(getAvatarInitials("foo..bar")).toBe("FB");
      expect(getAvatarInitials("foo.bar_baz")).toBe("FB");
      expect(getAvatarInitials("alice")).toBe("A");
    });

    it("handles email local parts and no-segment fallbacks", () => {
      expect(getAvatarInitials("hasan@q9labs.ai")).toBe("HA");
      expect(getAvatarInitials("foo.bar@example.com")).toBe("FB");
      expect(getAvatarInitials("a@x.com")).toBe("A");
      expect(getAvatarInitials("__")).toBe("__");
    });
  });

  describe("sanitizeAvatarGradientPreference", () => {
    it("keeps derived and valid preset preferences", () => {
      expect(sanitizeAvatarGradientPreference({ mode: "derived" })).toEqual(DEFAULT_AVATAR_GRADIENT_PREFERENCE);
      expect(
        sanitizeAvatarGradientPreference({
          mode: "preset",
          presetId: "mint",
        }),
      ).toEqual({
        mode: "preset",
        presetId: "mint",
      });
    });

    it("drops malformed values back to the derived default", () => {
      expect(sanitizeAvatarGradientPreference(null)).toEqual(DEFAULT_AVATAR_GRADIENT_PREFERENCE);
      expect(sanitizeAvatarGradientPreference({})).toEqual(DEFAULT_AVATAR_GRADIENT_PREFERENCE);
      expect(sanitizeAvatarGradientPreference({ mode: "unknown" })).toEqual(DEFAULT_AVATAR_GRADIENT_PREFERENCE);
      expect(sanitizeAvatarGradientPreference({ mode: "preset", presetId: "unknown" })).toEqual(DEFAULT_AVATAR_GRADIENT_PREFERENCE);
    });
  });

  describe("storage helpers", () => {
    it("reads stored preferences from localStorage safely", () => {
      browser.storage.setItem(
        "chalk_avatar_gradient",
        JSON.stringify({
          mode: "preset",
          presetId: "orchid",
        }),
      );

      expect(readStoredAvatarGradientPreference()).toEqual({
        mode: "preset",
        presetId: "orchid",
      });
      expect(browser.storage.getItem).toHaveBeenCalledWith("chalk_avatar_gradient");
    });

    it("falls back when stored preferences are missing or invalid", () => {
      expect(readStoredAvatarGradientPreference()).toEqual(DEFAULT_AVATAR_GRADIENT_PREFERENCE);

      browser.storage.setItem("chalk_avatar_gradient", "{not-json");
      expect(readStoredAvatarGradientPreference()).toEqual(DEFAULT_AVATAR_GRADIENT_PREFERENCE);

      browser.storage.setItem("chalk_avatar_gradient", JSON.stringify({ mode: "preset", presetId: "bad" }));
      expect(readStoredAvatarGradientPreference()).toEqual(DEFAULT_AVATAR_GRADIENT_PREFERENCE);
    });

    it("returns defaults on the server without touching storage", () => {
      installServerEnv();

      expect(readStoredAvatarGradientPreference()).toEqual(DEFAULT_AVATAR_GRADIENT_PREFERENCE);
      expect(readStoredDisplayName()).toBe("");
      expect(() => writeStoredAvatarGradientPreference({ mode: "preset", presetId: "mint" })).not.toThrow();
      expect(() => notifyUserSettingsUpdated()).not.toThrow();
    });

    it("writes the stored preference and dispatches the update event", () => {
      writeStoredAvatarGradientPreference({ mode: "preset", presetId: "mint" });

      expect(browser.storage.setItem).toHaveBeenCalledWith(
        "chalk_avatar_gradient",
        JSON.stringify({ mode: "preset", presetId: "mint" }),
      );
      expect(browser.dispatchEvent).toHaveBeenCalledTimes(1);
      const event = browser.dispatchEvent.mock.calls[0]?.[0];
      expect(event).toBeInstanceOf(Event);
      expect(event?.type).toBe("chalk-user-settings-updated");
    });

    it("reads the stored display name and falls back to an empty string", () => {
      expect(readStoredDisplayName()).toBe("");

      browser.storage.setItem("chalk_default_name", "Hasan");
      expect(readStoredDisplayName()).toBe("Hasan");
      expect(browser.storage.getItem).toHaveBeenCalledWith("chalk_default_name");
    });

    it("dispatches the settings-updated event for client listeners", () => {
      notifyUserSettingsUpdated();

      expect(browser.dispatchEvent).toHaveBeenCalledTimes(1);
      const event = browser.dispatchEvent.mock.calls[0]?.[0];
      expect(event).toBeInstanceOf(Event);
      expect(event?.type).toBe("chalk-user-settings-updated");
    });
  });

  describe("gradient resolution", () => {
    it("builds the css gradient string exactly", () => {
      expect(getAvatarGradientCss({ start: "#111111", end: "#222222" })).toBe("linear-gradient(135deg, #111111 0%, #222222 100%)");
    });

    it("returns exact derived gradients for representative seeds", () => {
      expect(resolveAvatarGradient("Hasan Shoaib")).toEqual({
        seed: "Hasan Shoaib",
        initials: "HS",
        colors: { start: "#f43f5e", end: "#fb923c" },
        css: "linear-gradient(135deg, #f43f5e 0%, #fb923c 100%)",
        label: "Derived from Hasan Shoaib",
        selection: "derived",
      });

      expect(resolveAvatarGradient("hasan@q9labs.ai")).toEqual({
        seed: "hasan@q9labs.ai",
        initials: "HA",
        colors: { start: "#f97316", end: "#eab308" },
        css: "linear-gradient(135deg, #f97316 0%, #eab308 100%)",
        label: "Derived from hasan@q9labs.ai",
        selection: "derived",
      });

      expect(resolveAvatarGradient("single")).toEqual({
        seed: "single",
        initials: "S",
        colors: { start: "#6366f1", end: "#8b5cf6" },
        css: "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
        label: "Derived from single",
        selection: "derived",
      });

      expect(resolveAvatarGradient("x")).toEqual({
        seed: "x",
        initials: "X",
        colors: { start: "#3b82f6", end: "#22d3ee" },
        css: "linear-gradient(135deg, #3b82f6 0%, #22d3ee 100%)",
        label: "Derived from x",
        selection: "derived",
      });

      expect(resolveAvatarGradient("a__b")).toEqual({
        seed: "a__b",
        initials: "AB",
        colors: { start: "#8b5cf6", end: "#ec4899" },
        css: "linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%)",
        label: "Derived from a__b",
        selection: "derived",
      });
    });

    it("uses the selected preset when explicitly requested", () => {
      expect(resolveAvatarGradient("Hasan Shoaib", { mode: "preset", presetId: "mint" })).toEqual({
        seed: "Hasan Shoaib",
        initials: "HS",
        colors: { start: "#10b981", end: "#14b8a6" },
        css: "linear-gradient(135deg, #10b981 0%, #14b8a6 100%)",
        label: "Mint",
        selection: "mint",
      });
    });

    it("falls back to the derived preset when the explicit preset is missing", () => {
      expect(resolveAvatarGradient("Hasan Shoaib", { mode: "preset", presetId: "missing" as never })).toEqual({
        seed: "Hasan Shoaib",
        initials: "HS",
        colors: { start: "#f43f5e", end: "#fb923c" },
        css: "linear-gradient(135deg, #f43f5e 0%, #fb923c 100%)",
        label: "Ember",
        selection: "ember",
      });
    });

    it("keeps the preset catalog stable for avatar selection", () => {
      expect(AVATAR_GRADIENT_PRESETS.map((preset) => preset.id)).toEqual(["ocean", "orchid", "mint", "sunset", "iris", "ember"]);
    });
  });
});
