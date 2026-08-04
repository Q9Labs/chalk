import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./SpacePeopleSheet.tsx", import.meta.url), "utf8");

describe("SpacePeopleSheet", () => {
  it("keeps Entrance admission and Participant action controls", () => {
    expect(source).toContain(">At the Entrance<");
    expect(source).toContain("controller.admitParticipant");
    expect(source).toContain("controller.denyAdmission");
    expect(source).toContain("accessibilityLabel={`Actions for ${participant.displayName}`}");
  });
});
