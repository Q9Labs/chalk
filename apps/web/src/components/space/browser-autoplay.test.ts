import { afterEach, expect, it, vi } from "vitest";
import { browserAllowsAutomaticEntry } from "./browser-autoplay";

afterEach(() => vi.unstubAllGlobals());

it("treats an audio probe construction failure as sound blocked", () => {
  vi.stubGlobal(
    "AudioContext",
    class {
      constructor() {
        throw new Error("Audio output is unavailable");
      }
    },
  );

  expect(browserAllowsAutomaticEntry()).toBe(false);
});

it("uses the probe context state and ignores a close rejection", () => {
  vi.stubGlobal(
    "AudioContext",
    class {
      readonly state = "running";
      async close() {
        throw new Error("close failed");
      }
    },
  );

  expect(browserAllowsAutomaticEntry()).toBe(true);
});

it("keeps unattended entry for an automated browser even when sound is blocked", () => {
  vi.stubGlobal("navigator", { webdriver: true });
  vi.stubGlobal("AudioContext", undefined);

  expect(browserAllowsAutomaticEntry()).toBe(true);
});
