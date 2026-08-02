import { describe, expect, it } from "vitest";

import { formatConferenceViewDuration } from "./format-meeting-room-duration";

describe("formatConferenceViewDuration", () => {
  it.each([
    [0, "0:00"],
    [59, "0:59"],
    [125, "2:05"],
  ])("formats %s elapsed seconds", (secondsElapsed, expected) => {
    expect(formatConferenceViewDuration(secondsElapsed)).toBe(expected);
  });
});
