import { describe, expect, it } from "vitest";
import { resolveMeeting } from "./meeting-lifecycle";

describe("resolveMeeting", () => {
  it("preserves the last meeting through disconnect teardown", () => {
    const currentMeeting = { id: "meeting_123" };

    expect(
      resolveMeeting({
        currentMeeting,
        nextMeeting: undefined,
        reason: "disconnected",
      }),
    ).toBe(currentMeeting);
  });

  it("uses the latest meeting when connecting", () => {
    const nextMeeting = { id: "meeting_456" };

    expect(
      resolveMeeting({
        currentMeeting: undefined,
        nextMeeting,
        reason: "connected",
      }),
    ).toBe(nextMeeting);
  });
});
