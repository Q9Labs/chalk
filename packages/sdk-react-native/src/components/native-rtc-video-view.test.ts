import { describe, expect, it } from "vitest";
import { canRenderNativeRtcVideoView } from "./native-rtc-video-view-availability";

describe("canRenderNativeRtcVideoView", () => {
  it("returns false when the native preview component is unavailable", () => {
    expect(canRenderNativeRtcVideoView(undefined)).toBe(false);
    expect(canRenderNativeRtcVideoView(null)).toBe(false);
  });

  it("returns true for component-like values", () => {
    const PreviewVideo = () => null;

    expect(canRenderNativeRtcVideoView(PreviewVideo)).toBe(true);
  });
});
