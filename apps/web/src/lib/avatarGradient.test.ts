import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getParticipantAvatarGradient, getParticipantAvatarRecipe, getParticipantInitials, PARTICIPANT_GRADIENT_PRESETS } from "@q9labs/chalk-core";

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

  return { dispatchEvent, storage };
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
    it("preserves the web fallback while delegating actual initials generation to the SDK", () => {
      expect(getAvatarInitials()).toBe("CU");
      expect(getAvatarInitials("Hasan Shoaib")).toBe(getParticipantInitials("Hasan Shoaib"));
      expect(getAvatarInitials("hasan@q9labs.ai")).toBe(getParticipantInitials("hasan@q9labs.ai"));
      expect(getAvatarInitials("foo.bar_baz")).toBe(getParticipantInitials("foo.bar_baz"));
    });
  });

  describe("sanitizeAvatarGradientPreference", () => {
    it("keeps derived and valid SDK-backed preset preferences", () => {
      const preset = AVATAR_GRADIENT_PRESETS[0]!;

      expect(sanitizeAvatarGradientPreference({ mode: "derived" })).toEqual(DEFAULT_AVATAR_GRADIENT_PREFERENCE);
      expect(
        sanitizeAvatarGradientPreference({
          mode: "preset",
          presetId: preset.id,
        }),
      ).toEqual({
        mode: "preset",
        presetId: preset.id,
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
      const preset = AVATAR_GRADIENT_PRESETS[1]!;
      browser.storage.setItem(
        "chalk_avatar_gradient",
        JSON.stringify({
          mode: "preset",
          presetId: preset.id,
        }),
      );

      expect(readStoredAvatarGradientPreference()).toEqual({
        mode: "preset",
        presetId: preset.id,
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
      expect(() => writeStoredAvatarGradientPreference({ mode: "preset", presetId: AVATAR_GRADIENT_PRESETS[0]!.id })).not.toThrow();
      expect(() => notifyUserSettingsUpdated()).not.toThrow();
    });

    it("writes the stored preference and dispatches the update event", () => {
      const preset = AVATAR_GRADIENT_PRESETS[2]!;
      writeStoredAvatarGradientPreference({ mode: "preset", presetId: preset.id });

      expect(browser.storage.setItem).toHaveBeenCalledWith("chalk_avatar_gradient", JSON.stringify({ mode: "preset", presetId: preset.id }));
      expect(browser.dispatchEvent).toHaveBeenCalledTimes(1);
      const event = browser.dispatchEvent.mock.calls[0]?.[0];
      expect(event).toBeInstanceOf(Event);
      expect(event?.type).toBe("chalk-user-settings-updated");
    });

    it("reads the stored display name and falls back to an empty string", () => {
      expect(readStoredDisplayName()).toBe("");

      browser.storage.setItem(
        "chalk-meeting-settings",
        JSON.stringify({
          identity: {
            displayName: "Hasan",
          },
        }),
      );
      expect(readStoredDisplayName()).toBe("Hasan");
      expect(browser.storage.getItem).toHaveBeenCalledWith("chalk-meeting-settings");
    });

    it("dispatches the settings-updated event for client listeners", () => {
      notifyUserSettingsUpdated();

      expect(browser.dispatchEvent).toHaveBeenCalledTimes(2);
      expect(browser.dispatchEvent.mock.calls.map((call) => (call[0] as Event)?.type)).toEqual(["chalk-user-settings-updated", "chalk-settings-updated"]);
    });
  });

  describe("gradient resolution", () => {
    it("builds css gradients via the SDK helper", () => {
      expect(getAvatarGradientCss({ start: "#111111", end: "#222222" })).toBe(
        getParticipantAvatarGradient("Chalk User", {
          mode: "custom",
          from: "#111111",
          to: "#222222",
        }),
      );
    });

    it("derives avatar gradients from the shared SDK recipe", () => {
      const expected = getParticipantAvatarRecipe("Hasan Shoaib");

      expect(resolveAvatarGradient("Hasan Shoaib")).toEqual({
        seed: "Hasan Shoaib",
        initials: expected.initials,
        colors: { start: expected.colors.primary, end: expected.colors.gradientEnd },
        css: expected.avatarGradient,
        label: "Derived from Hasan Shoaib",
        selection: "derived",
      });
    });

    it("pins preset gradients using SDK preset colors instead of a web-local palette", () => {
      const preset = AVATAR_GRADIENT_PRESETS[3]!;

      expect(resolveAvatarGradient("Hasan Shoaib", { mode: "preset", presetId: preset.id })).toEqual({
        seed: "Hasan Shoaib",
        initials: getParticipantAvatarRecipe("Hasan Shoaib", { mode: "custom", from: preset.start, to: preset.end }).initials,
        colors: { start: preset.start, end: preset.end },
        css: getParticipantAvatarGradient("Hasan Shoaib", { mode: "custom", from: preset.start, to: preset.end }),
        label: preset.label,
        selection: preset.id,
      });
    });

    it("keeps the exported preset list aligned with sdk-core", () => {
      expect(AVATAR_GRADIENT_PRESETS).toEqual(
        PARTICIPANT_GRADIENT_PRESETS.map((preset) => ({
          id: preset.id,
          label: preset.label,
          start: preset.from,
          end: preset.to,
        })),
      );
    });
  });
});
