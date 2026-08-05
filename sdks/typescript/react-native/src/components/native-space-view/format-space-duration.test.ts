import { describe, expect, it } from "vitest";

import { formatSpaceDuration } from "./format-space-duration";

describe("formatSpaceDuration", () => {
  it.each([
    [0, "0:00"],
    [59, "0:59"],
    [125, "2:05"],
  ])("formats %s elapsed seconds", (secondsElapsed, expected) => {
    expect(formatSpaceDuration(secondsElapsed)).toBe(expected);
  });
});
