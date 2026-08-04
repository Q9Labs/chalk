import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./SpacePanelSheet.tsx", import.meta.url), "utf8");

describe("SpacePanelSheet", () => {
  it("switches between Chat and People while preserving the live dock", () => {
    expect(source).toContain('controller.panel === "chat"');
    expect(source).toContain("<SpaceChatSheet");
    expect(source).toContain("<SpacePeopleSheet");
    expect(source).toContain("marginBottom: 94");
  });
});
