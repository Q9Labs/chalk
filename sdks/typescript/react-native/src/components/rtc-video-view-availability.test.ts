import { memo } from "react";
import { describe, expect, it } from "vitest";
import { canRenderRtcVideoView } from "./rtc-video-view-availability";

describe("native video view availability", () => {
  it("accepts the registered host component exported by native WebRTC", () => {
    // requireNativeComponent registers the view and returns its name at runtime.
    expect(canRenderRtcVideoView("RTKRTCVideoView")).toBe(true);
  });

  it("accepts function and object component exports", () => {
    expect(canRenderRtcVideoView(() => null)).toBe(true);
    expect(canRenderRtcVideoView(memo(() => null))).toBe(true);
  });

  it.each([undefined, null, "", false, 0])("rejects an unavailable export: %s", (component) => {
    expect(canRenderRtcVideoView(component)).toBe(false);
  });
});
