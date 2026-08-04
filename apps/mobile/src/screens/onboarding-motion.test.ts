import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./onboarding-motion.ts", import.meta.url), "utf8");

describe("onboarding motion", () => {
  it("observes the native reduced-motion preference and cleans up", () => {
    expect(source).toContain("AccessibilityInfo.isReduceMotionEnabled()");
    expect(source).toContain('addEventListener("reduceMotionChanged"');
    expect(source).toContain("subscription.remove()");
  });
});
