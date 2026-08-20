import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./HomeScreen.shared.tsx", import.meta.url), "utf8");

describe("HomeScreenShared", () => {
  it("uses the quiet illustrated Home hierarchy and opens Create in a sheet", () => {
    expect(source).not.toContain("YOUR WORK, TOGETHER");
    expect(source).not.toContain("headerLabel");
    expect(source).toContain("CreateSpaceIllustration");
    expect(source).toContain("SpaceHistoryIllustration");
    expect(source).toContain("CreateSpaceSheet");
    expect(source).toContain("setCreateSheetOpen(true)");
    expect(source).toContain("createPublicSpaceRoute");
    expect(source).toContain("Open Space invite");
    expect(source).toContain('accessibilityLabel="Create a Space"');
    expect(source).not.toContain("local Space");
  });
});
