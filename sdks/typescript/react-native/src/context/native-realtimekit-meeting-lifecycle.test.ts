import { describe, expect, it } from "vitest";
import { resolveNativeRealtimeKitMeeting } from "./native-realtimekit-meeting-lifecycle";

describe("resolveNativeRealtimeKitMeeting", () => {
  it("preserves the last RTK meeting when disconnecting", () => {
    const currentMeeting = { id: "meeting_123" };

    expect(
      resolveNativeRealtimeKitMeeting({
        currentMeeting,
        nextMeeting: null,
        reason: "disconnected",
      }),
    ).toBe(currentMeeting);
  });

  it("accepts the latest RTK meeting when connecting", () => {
    const nextMeeting = { id: "meeting_456" };

    expect(
      resolveNativeRealtimeKitMeeting({
        currentMeeting: null,
        nextMeeting,
        reason: "connected",
      }),
    ).toBe(nextMeeting);
  });
});
