import { describe, expect, it } from "vitest";

import { formatDuration } from "./space-header-contract";

describe("formatDuration", () => {
  it.each([
    [0, "00:00:00"],
    [2, "00:00:02"],
    [3661, "01:01:01"],
    [86399, "23:59:59"],
  ])("formats %s seconds as %s", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});
