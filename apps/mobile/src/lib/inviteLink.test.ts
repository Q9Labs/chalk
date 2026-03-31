import { describe, expect, it } from "vitest";
import { extractJoinTokenFromInviteLink, getClipboardInviteSuggestion } from "./inviteLink";

describe("extractJoinTokenFromInviteLink", () => {
  it("accepts Chalk https invite links", () => {
    expect(extractJoinTokenFromInviteLink("https://chalk.q9labs.ai/j/join-token-123")).toBe("join-token-123");
  });

  it("accepts the new Chalk meet host", () => {
    expect(extractJoinTokenFromInviteLink("https://chalkmeet.com/j/join-token-123")).toBe("join-token-123");
  });

  it("accepts bare Chalk invite hostnames", () => {
    expect(extractJoinTokenFromInviteLink("chalk.q9labs.ai/j/join-token-123")).toBe("join-token-123");
  });

  it("accepts bare Chalk meet hostnames", () => {
    expect(extractJoinTokenFromInviteLink("chalkmeet.com/j/join-token-123")).toBe("join-token-123");
  });

  it("accepts native Chalk deep links", () => {
    expect(extractJoinTokenFromInviteLink("chalk://j/join-token-123")).toBe("join-token-123");
  });

  it("rejects direct room links and raw codes", () => {
    expect(extractJoinTokenFromInviteLink("https://chalk.q9labs.ai/room/2f0b302b-2449-43f5-ae3b-de57decb9f09")).toBeNull();
    expect(extractJoinTokenFromInviteLink("ABC123")).toBeNull();
  });
});

describe("getClipboardInviteSuggestion", () => {
  it("returns a copied Chalk invite link when it differs from the current input", () => {
    expect(getClipboardInviteSuggestion("https://chalkmeet.com/j/join-token-123", "")).toBe("https://chalkmeet.com/j/join-token-123");
  });

  it("hides the suggestion when the input already matches the clipboard", () => {
    expect(getClipboardInviteSuggestion("https://chalkmeet.com/j/join-token-123", "https://chalkmeet.com/j/join-token-123")).toBeNull();
  });

  it("ignores non-invite clipboard values", () => {
    expect(getClipboardInviteSuggestion("ABC123", "")).toBeNull();
  });
});
