import { describe, expect, it } from "vitest";
import { CameraBackgroundPreferences, CAMERA_BACKGROUND_OPTIONS, isCameraBackground } from "./camera-background-settings";

describe("camera background preferences", () => {
  function storage() {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  }
  it("defaults to None and remembers each camera separately across page loads", () => {
    const saved = storage();
    const first = new CameraBackgroundPreferences(() => saved);
    expect(first.get("front")).toBe("none");
    first.set("front", "blur");
    first.set("back", "garden-terrace-lounge");
    const reload = new CameraBackgroundPreferences(() => saved);
    expect(reload.get("front")).toBe("blur");
    expect(reload.get("back")).toBe("garden-terrace-lounge");
    expect(reload.get("external")).toBe("none");
  });
  it("rejects removed, malformed, and custom-upload values at the storage boundary", () => {
    for (const value of ["custom", "data:image/png;base64,abc", '{"kind":"blur"}', "", "toString"]) {
      expect(new CameraBackgroundPreferences(() => ({ getItem: () => value, setItem: () => {} })).get("camera")).toBe("none");
    }
  });
  it("keeps the chosen effect when storage throws", () => {
    const preferences = new CameraBackgroundPreferences(() => { throw new Error("Storage blocked"); });
    expect(preferences.get("camera")).toBe("none");
    preferences.set("camera", "blur");
    expect(preferences.get("camera")).toBe("blur");
  });
  it("offers only None, Blur, and six images hosted by Chalk", () => {
    expect(CAMERA_BACKGROUND_OPTIONS).toHaveLength(8);
    for (const option of CAMERA_BACKGROUND_OPTIONS) {
      expect(isCameraBackground(option.id)).toBe(true);
      if (option.image) expect(new URL(option.image).hostname).toBe("assets.chalkmeet.com");
    }
    expect(isCameraBackground(null)).toBe(false);
  });
});
