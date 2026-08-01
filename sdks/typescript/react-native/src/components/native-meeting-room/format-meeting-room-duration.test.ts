import { describe, expect, it } from "vitest";

import { formatMeetingRoomDuration } from "./format-meeting-room-duration";

describe("formatMeetingRoomDuration", () => {
  it.each([
    [0, "0:00"],
    [59, "0:59"],
    [125, "2:05"],
  ])("formats %s elapsed seconds", (secondsElapsed, expected) => {
    expect(formatMeetingRoomDuration(secondsElapsed)).toBe(expected);
  });
});
