import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./OnboardingScreen.tsx", import.meta.url), "utf8");

describe("OnboardingScreen", () => {
  it("keeps setup accessible and route-neutral", () => {
    expect(source).toContain('accessibilityRole="progressbar"');
    expect(source).toContain('"Finish setup"');
    expect(source).toContain("saveOnboardingState(name)");
  });
});
