import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("App public invite wiring", () => {
  it("routes canonical Space links into the public arrival screen", () => {
    expect(source).toContain("parseSpaceLink");
    expect(source).toContain("MobileSpaceScreen");
    expect(source).toContain("parseSpaceLink(url)");
    expect(source).toContain("apiBaseURL");
    expect(source).toContain("DevDiagnosticsSheet");
  });
});
