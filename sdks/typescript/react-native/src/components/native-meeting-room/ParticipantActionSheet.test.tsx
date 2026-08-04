import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./ParticipantActionSheet.tsx", import.meta.url), "utf8");

describe("ParticipantActionSheet", () => {
  it("keeps capability-derived actions and explicit destructive styling", () => {
    expect(source).toContain("buildParticipantActionDescriptors(role");
    expect(source).toContain("descriptor.destructive");
    expect(source).toContain('accessibilityLabel="Close Participant actions"');
    expect(source).toContain("StyleSheet.absoluteFillObject");
    expect(source).not.toContain("paddingBottom: 112");
    expect(source).not.toContain("bottom: 94");
  });
});
