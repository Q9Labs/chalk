import { describe, expect, it } from "vitest";
import { getClipboardInviteSuggestion, parseSpaceInviteLink } from "./invites";

describe("parseSpaceInviteLink", () => {
  const inviteToken = "cspi1.key.payload.signature";

  it("accepts Chalk https invite links", () => {
    expect(parseSpaceInviteLink(`https://chalk.q9labs.ai/space/design-lab#spaceInviteToken=${inviteToken}`)).toEqual({ slug: "design-lab", spaceInviteToken: inviteToken });
  });

  it("accepts bare Chalk hostnames", () => {
    expect(parseSpaceInviteLink(`chalkmeet.com/space/design-lab#spaceInviteToken=${inviteToken}`)).toEqual({ slug: "design-lab", spaceInviteToken: inviteToken });
  });

  it("accepts native Chalk deep links with the canonical path", () => {
    expect(parseSpaceInviteLink(`chalk://space/design-lab#spaceInviteToken=${inviteToken}`)).toEqual({ slug: "design-lab", spaceInviteToken: inviteToken });
    expect(parseSpaceInviteLink(`ai.q9labs.chalk.mobile://space/design-lab#spaceInviteToken=${inviteToken}`)).toEqual({ slug: "design-lab", spaceInviteToken: inviteToken });
  });

  it("accepts loopback HTTP invite links for local development", () => {
    expect(parseSpaceInviteLink(`http://127.0.0.1:3070/space/design-lab#spaceInviteToken=${inviteToken}`)).toEqual({ slug: "design-lab", spaceInviteToken: inviteToken });
    expect(parseSpaceInviteLink(`http://localhost:3070/space/design-lab#spaceInviteToken=${inviteToken}`)).toEqual({ slug: "design-lab", spaceInviteToken: inviteToken });
  });

  it("rejects legacy paths, missing slugs, and invalid tokens", () => {
    expect(parseSpaceInviteLink(`https://chalk.q9labs.ai/legacy/${inviteToken}`)).toBeNull();
    expect(parseSpaceInviteLink(`https://chalk.q9labs.ai/space#spaceInviteToken=${inviteToken}`)).toBeNull();
    expect(parseSpaceInviteLink("https://chalk.q9labs.ai/space/design-lab#invite=legacy")).toBeNull();
    expect(parseSpaceInviteLink("https://attacker.test/space/design-lab#spaceInviteToken=cspi1.key.payload.signature")).toBeNull();
    expect(parseSpaceInviteLink(`http://chalkmeet.com/space/design-lab#spaceInviteToken=${inviteToken}`)).toBeNull();
    expect(parseSpaceInviteLink(`http://192.168.1.10/space/design-lab#spaceInviteToken=${inviteToken}`)).toBeNull();
    expect(parseSpaceInviteLink("https://chalk.q9labs.ai/space/design-lab#spaceInviteToken=ABC123")).toBeNull();
    expect(parseSpaceInviteLink(`https://chalk.q9labs.ai/space/design-lab#spaceInviteToken=${`cspi1.${"k".repeat(170)}.${"p".repeat(170)}.${"s".repeat(170)}`}`)).toBeNull();
  });
});

describe("getClipboardInviteSuggestion", () => {
  const inviteLink = "https://chalkmeet.com/space/design-lab#spaceInviteToken=cspi1.key.payload.signature";

  it("returns a copied Chalk invite link when it differs from the current input", () => {
    expect(getClipboardInviteSuggestion(inviteLink, "")).toBe(inviteLink);
  });

  it("hides the suggestion when the input already matches the clipboard", () => {
    expect(getClipboardInviteSuggestion(inviteLink, inviteLink)).toBeNull();
  });

  it("ignores non-invite clipboard values", () => {
    expect(getClipboardInviteSuggestion("ABC123", "")).toBeNull();
  });
});
