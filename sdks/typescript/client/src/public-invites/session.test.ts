import { describe, expect, it } from "vitest";
import { opaqueAccessGrant } from "../space-client/core.test.helpers";
import { createPublicSpaceSession } from "./session";
import type { ChalkPublicClient } from "./types";

type RefreshRequest = Parameters<ChalkPublicClient["refreshSpacePublicInviteAccess"]>[0];

/** A fake client that records what the session sent. `leaves` counts leave requests; `failLeaves` makes that many fail first. */
function fakeClient({ failRefresh = false, failLeaves = 0, leaveError = new Error("offline") as unknown } = {}) {
  const refreshes: RefreshRequest[] = [];
  let leaves = 0;
  const client = {
    refreshSpacePublicInviteAccess: async (request: RefreshRequest) => {
      refreshes.push(request);
      if (failRefresh) throw new Error("offline");
      return opaqueAccessGrant(2);
    },
    leaveSpacePublicInviteArrival: async () => {
      leaves += 1;
      if (leaves <= failLeaves) throw leaveError;
    },
  } as unknown as ChalkPublicClient;
  return { client, refreshes, leaves: () => leaves };
}

describe("public Space session", () => {
  it("hands out the first grant once, then trades the media token for a fresh grant", async () => {
    const first = opaqueAccessGrant(1);
    const { client, refreshes } = fakeClient();
    const session = createPublicSpaceSession(client, { arrivalHandle: "handle-1", access: first });
    let refreshedNotices = 0;
    session.subscribe(() => {
      refreshedNotices += 1;
    });

    await expect(session.getAccess({ space: "s", reason: "join", replaceMediaConnection: false })).resolves.toBe(first);
    expect(refreshes).toEqual([]);

    const proof = session.mediaProof();
    await session.getAccess({ space: "s", reason: "refresh", replaceMediaConnection: false });
    expect(refreshes).toEqual([expect.objectContaining({ arrivalHandle: "handle-1", mediaProof: proof, replaceMediaConnection: false })]);
    expect(session.mediaProof()).not.toBe(proof);
    expect(refreshedNotices).toBe(1);
  });

  it("forwards the media-replacement flag the client asked for, whatever the reason", async () => {
    const { client, refreshes } = fakeClient();
    const session = createPublicSpaceSession(client, { arrivalHandle: "handle-1", access: opaqueAccessGrant(1) });

    await session.getAccess({ space: "s", reason: "refresh", replaceMediaConnection: true });
    await session.getAccess({ space: "s", reason: "retry", replaceMediaConnection: false });
    await session.getAccess({ space: "s", reason: "retry", replaceMediaConnection: true });
    expect(refreshes.map((request) => request.replaceMediaConnection)).toEqual([true, false, true]);
  });

  it("reports a failed refresh and keeps the old token", async () => {
    const outcomes: string[] = [];
    const { client } = fakeClient({ failRefresh: true });
    const session = createPublicSpaceSession(client, { arrivalHandle: "handle-1", access: opaqueAccessGrant(1) }, { onRefresh: (outcome) => outcomes.push(outcome) });
    const proof = session.mediaProof();

    await expect(session.getAccess({ space: "s", reason: "refresh", replaceMediaConnection: false })).rejects.toThrow("offline");
    expect(outcomes).toContain("failed");
    expect(session.mediaProof()).toBe(proof);
  });

  it("leaves once, tolerates an arrival the server dropped, and refuses access afterwards", async () => {
    const { client, leaves } = fakeClient({ failLeaves: Number.POSITIVE_INFINITY, leaveError: { status: 404 } });
    const session = createPublicSpaceSession(client, { arrivalHandle: "handle-1", access: opaqueAccessGrant(1) });

    await session.leave();
    await session.leave();
    expect(leaves()).toBe(1);
    await expect(session.getAccess({ space: "s", reason: "refresh", replaceMediaConnection: false })).rejects.toThrow("released");
  });

  it("lets a failed leave be tried again", async () => {
    const { client, leaves } = fakeClient({ failLeaves: 1 });
    const session = createPublicSpaceSession(client, { arrivalHandle: "handle-1", access: opaqueAccessGrant(1) });

    await expect(session.leave()).rejects.toThrow("offline");
    await session.leave();
    expect(leaves()).toBe(2);
  });

  it("shares one request between leaves that overlap", async () => {
    const { client, leaves } = fakeClient();
    const session = createPublicSpaceSession(client, { arrivalHandle: "handle-1", access: opaqueAccessGrant(1) });

    await Promise.all([session.leave(), session.leave()]);
    expect(leaves()).toBe(1);
  });
});
