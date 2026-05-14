import { describe, expect, it } from "vitest";
import { buildEyeTransform } from "../native-blink";

describe("buildEyeTransform", () => {
  it("returns an explicit identity transform for open eyes", () => {
    expect(buildEyeTransform({ x: 10.5, y: 4.5 }, 1)).toBe("translate(10.5 4.5) scale(1 1) translate(-10.5 -4.5)");
  });

  it("returns a collapsed transform for blinks", () => {
    expect(buildEyeTransform({ x: 7.2, y: 7.2 }, 0.05)).toBe("translate(7.2 7.2) scale(1 0.05) translate(-7.2 -7.2)");
  });
});
