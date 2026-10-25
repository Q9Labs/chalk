/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { canonicalSpaceInviteLink, verifiedSpaceInviteLink } from "./named-space-route";

describe("Space invite links", () => {
  it("builds a short link from an invite code", () => {
    expect(canonicalSpaceInviteLink("design-lab", "ABCDEFGHIJ")).toBe(`${window.location.origin}/abc-defg-hij`);
  });

  it("builds and verifies word links", () => {
    const link = `${window.location.origin}/snap-noodle-groom-koala`;
    expect(canonicalSpaceInviteLink("design-lab", " SNAP.NOODLE groom-KOALA ")).toBe(link);
    expect(verifiedSpaceInviteLink("design-lab", link)).toBe(link);
  });

  it("keeps building legacy token links", () => {
    expect(canonicalSpaceInviteLink("design-lab", "cspi1.key.payload.signature")).toBe(`${window.location.origin}/space/design-lab#spaceInviteToken=cspi1.key.payload.signature`);
  });

  it("accepts canonical short links from the API", () => {
    const link = `${window.location.origin}/abc-defg-hij`;
    expect(verifiedSpaceInviteLink("design-lab", link)).toBe(link);
  });

  it("accepts legacy links during deploy transitions", () => {
    const link = `${window.location.origin}/space/design-lab#spaceInviteToken=cspi1.key.payload.signature`;
    expect(verifiedSpaceInviteLink("design-lab", link)).toBe(link);
  });

  it.each([`${window.location.origin}/ABC-DEFG-HIJ`, `${window.location.origin}/abc-defg-hij?x=1`, "https://evil.example/abc-defg-hij"])("rejects invalid API links", (link) => {
    expect(() => verifiedSpaceInviteLink("design-lab", link)).toThrow();
  });
});
