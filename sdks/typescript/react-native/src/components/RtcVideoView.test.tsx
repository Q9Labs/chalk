import { describe, expect, it, vi } from "vitest";

vi.mock("../media/native-webrtc", () => ({ RTCView: () => null }));

describe("RtcVideoView", () => {
  it("reports the availability of the RTC view", async () => {
    const { hasRtcVideoView, RtcVideoView } = await import("./RtcVideoView");

    expect(hasRtcVideoView()).toBe(true);
    expect(RtcVideoView({ streamURL: "stream" })).toBeTruthy();
  });
});
