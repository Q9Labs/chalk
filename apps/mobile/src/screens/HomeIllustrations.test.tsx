import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./HomeIllustrations.tsx", import.meta.url), "utf8");

describe("Home illustrations", () => {
  it("provides decorative Create and history scenes without polluting accessibility", () => {
    expect(source).toContain("export function CreateSpaceIllustration");
    expect(source).toContain("export function SpaceHistoryIllustration");
    expect(source).toContain("accessibilityElementsHidden");
    expect(source).toContain('importantForAccessibility="no-hide-descendants"');
  });
});
