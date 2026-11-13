import { SpacePublicInviteUnavailableError } from "@q9labsai/chalk-client";
import { describe, expect, it } from "vitest";
import { declinedFailure, entryFailure, neutralSpaceError } from "./entry-failure";

describe("entryFailure", () => {
  it("tells an unavailable invite link from an unknown Space", () => {
    expect(entryFailure(new SpacePublicInviteUnavailableError({ error: { code: "space_public_invite.unavailable", message: "gone" } })).retryable).toBe(false);
    expect(entryFailure({ status: 404 }).message).toBe(neutralSpaceError);
  });

  it("lets the visitor retry a rate limit, a conflict and a network failure", () => {
    expect(entryFailure({ status: 429 }).retryable).toBe(true);
    expect(entryFailure({ status: 409 }).retryable).toBe(true);
    expect(entryFailure(new Error("offline")).retryable).toBe(true);
  });
});

describe("declinedFailure", () => {
  it("marks a decline and an expiry so the lobby can word them", () => {
    expect(declinedFailure("rejected").reason).toBe("declined");
    expect(declinedFailure("unavailable").reason).toBe("expired");
    expect(declinedFailure("anything else").reason).toBeUndefined();
  });
});
