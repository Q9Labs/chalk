import { describe, expect, it } from "bun:test";
import { buildChalkInviteLink } from "./build-chalk-invite-link";

describe("buildChalkInviteLink", () => {
  it("builds a Chalk invite link with the public host", () => {
    expect(buildChalkInviteLink("join-token-123")).toBe("https://chalkmeet.com/j/join-token-123");
  });

  it("normalizes trailing slashes on custom origins", () => {
    expect(buildChalkInviteLink("join-token-123", "https://chalk.q9labs.ai/")).toBe("https://chalk.q9labs.ai/j/join-token-123");
  });
});
