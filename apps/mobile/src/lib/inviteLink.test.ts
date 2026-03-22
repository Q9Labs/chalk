import { describe, expect, it } from "bun:test";
import { extractJoinTokenFromInviteLink } from "./inviteLink";

describe("extractJoinTokenFromInviteLink", () => {
  it("accepts Chalk https invite links", () => {
    expect(extractJoinTokenFromInviteLink("https://chalk.q9labs.ai/j/join-token-123")).toBe("join-token-123");
  });

  it("accepts bare Chalk invite hostnames", () => {
    expect(extractJoinTokenFromInviteLink("chalk.q9labs.ai/j/join-token-123")).toBe("join-token-123");
  });

  it("accepts native Chalk deep links", () => {
    expect(extractJoinTokenFromInviteLink("chalk://j/join-token-123")).toBe("join-token-123");
  });

  it("rejects direct room links and raw codes", () => {
    expect(extractJoinTokenFromInviteLink("https://chalk.q9labs.ai/room/2f0b302b-2449-43f5-ae3b-de57decb9f09")).toBeNull();
    expect(extractJoinTokenFromInviteLink("ABC123")).toBeNull();
  });
});
