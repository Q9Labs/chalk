import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./SpaceSurfacePrimitives.tsx", import.meta.url), "utf8");

describe("Space surface primitives", () => {
  it("keeps accessible close targets and flat deterministic avatars", () => {
    expect(source).toContain('accessibilityRole="button"');
    expect(source).toContain("getParticipantInitials(name)");
    expect(source).toContain("getParticipantColor(name)");
  });
});
