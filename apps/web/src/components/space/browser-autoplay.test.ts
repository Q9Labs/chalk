import { afterEach, expect, it, vi } from "vitest";
import { browserAllowsMediaAutoplay } from "./browser-autoplay";

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

  expect(browserAllowsMediaAutoplay()).toBe(false);
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

  expect(browserAllowsMediaAutoplay()).toBe(true);
});
