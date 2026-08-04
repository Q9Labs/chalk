import { describe, expect, it } from "vitest";
import { extractJoinTokenFromInviteLink, getClipboardInviteSuggestion } from "./invites";

describe("extractJoinTokenFromInviteLink", () => {
  const inviteToken = "i".repeat(43);

  it("accepts Chalk https invite links", () => {
    expect(extractJoinTokenFromInviteLink(`https://chalk.q9labs.ai/j/${inviteToken}`)).toBe(inviteToken);
  });

  it("accepts the new Chalk meet host", () => {
    expect(extractJoinTokenFromInviteLink(`https://chalkmeet.com/j/${inviteToken}`)).toBe(inviteToken);
  });

  it("accepts the canonical access hash", () => {
    expect(extractJoinTokenFromInviteLink(`https://chalkmeet.com/#access=${inviteToken}`)).toBe(inviteToken);
  });

  it("accepts bare Chalk invite hostnames", () => {
    expect(extractJoinTokenFromInviteLink(`chalk.q9labs.ai/j/${inviteToken}`)).toBe(inviteToken);
  });

  it("accepts bare Chalk meet hostnames", () => {
    expect(extractJoinTokenFromInviteLink(`chalkmeet.com/j/${inviteToken}`)).toBe(inviteToken);
  });

  it("accepts native Chalk deep links", () => {
    expect(extractJoinTokenFromInviteLink(`chalk://j/${inviteToken}`)).toBe(inviteToken);
  });

  it("accepts bundle-scheme Chalk deep links", () => {
    expect(extractJoinTokenFromInviteLink(`ai.q9labs.chalk.mobile://j/${inviteToken}`)).toBe(inviteToken);
  });

  it("rejects direct Space links and raw codes", () => {
    expect(extractJoinTokenFromInviteLink("https://chalk.q9labs.ai/space/2f0b302b-2449-43f5-ae3b-de57decb9f09")).toBeNull();
    expect(extractJoinTokenFromInviteLink(`https://attacker.test/j/${inviteToken}`)).toBeNull();
    expect(extractJoinTokenFromInviteLink("ABC123")).toBeNull();
  });
});

describe("getClipboardInviteSuggestion", () => {
  const inviteToken = "i".repeat(43);

  it("returns a copied Chalk invite link when it differs from the current input", () => {
    expect(getClipboardInviteSuggestion(`https://chalkmeet.com/j/${inviteToken}`, "")).toBe(`https://chalkmeet.com/j/${inviteToken}`);
  });

  it("hides the suggestion when the input already matches the clipboard", () => {
    expect(getClipboardInviteSuggestion(`https://chalkmeet.com/j/${inviteToken}`, `https://chalkmeet.com/j/${inviteToken}`)).toBeNull();
  });

  it("ignores non-invite clipboard values", () => {
    expect(getClipboardInviteSuggestion("ABC123", "")).toBeNull();
  });
});
