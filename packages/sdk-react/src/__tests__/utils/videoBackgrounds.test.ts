import { describe, expect, it } from "vitest";
import { VIDEO_BACKGROUND_PRESETS, toRuntimeVideoBackgroundEffect } from "../../utils/videoBackgrounds";

describe("videoBackgrounds", () => {
  it("ships preset backgrounds as local SDK assets instead of remote CDN URLs", () => {
    for (const preset of VIDEO_BACKGROUND_PRESETS) {
      expect(preset.imageUrl).toBeTruthy();
      expect(preset.imageUrl.includes("rtk-assets.realtime.cloudflare.com")).toBe(false);
    }
  });

  it("maps preset effects to local runtime image URLs", () => {
    const effect = toRuntimeVideoBackgroundEffect({
      type: "preset",
      presetId: "preset-classroom",
    });

    expect(effect).toMatchObject({
      mode: "image",
    });
    expect(effect.mode === "image" && effect.imageUrl.includes("rtk-assets.realtime.cloudflare.com")).toBe(false);
  });
});
