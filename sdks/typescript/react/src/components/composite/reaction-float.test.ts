import { describe, expect, it } from "vitest";

import { REACTION_RISE_MS, reactionFloatStyle } from "./reaction-float";

describe("reactionFloatStyle", () => {
  it("returns stable positioning for the same event id", () => {
    const style = reactionFloatStyle("reaction-123");

    expect(reactionFloatStyle("reaction-123")).toEqual(style);
    expect(style["--reaction-duration"]).toBe(`${REACTION_RISE_MS}ms`);
  });

  it("changes the animation duration and positioning when inputs change", () => {
    const style = reactionFloatStyle("reaction-123");
    const customDurationStyle = reactionFloatStyle("reaction-123", 1800);

    expect(customDurationStyle).toEqual({ ...style, "--reaction-duration": "1800ms" });
    expect(reactionFloatStyle("reaction-456")).not.toEqual(style);
  });
});
