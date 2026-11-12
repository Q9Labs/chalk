import { describe, expect, it, vi } from "vitest";
import { opaqueAccessGrant } from "../space-client/core.test.helpers";
import { createPublicSpaceSession } from "./session";
import type { ChalkPublicClient } from "./types";

function fakeClient(overrides: Partial<ChalkPublicClient> = {}) {
  const refresh = vi.fn(async () => opaqueAccessGrant(2));
  const leave = vi.fn(async () => undefined);
  const client = { refreshSpacePublicInviteAccess: refresh, leaveSpacePublicInviteArrival: leave, ...overrides } as unknown as ChalkPublicClient;
  return { client, refresh, leave };
}

describe("public Space session", () => {
  it("hands out the first grant once, then trades the media token for a fresh grant", async () => {
    const first = opaqueAccessGrant(1);
    const { client, refresh } = fakeClient();
    const session = createPublicSpaceSession(client, { arrivalHandle: "handle-1", access: first });
    const refreshed = vi.fn();
    session.subscribe(refreshed);

    await expect(session.getAccess({ space: "s", reason: "join", replaceMediaConnection: false })).resolves.toBe(first);
    expect(refresh).not.toHaveBeenCalled();

    const proof = session.mediaProof();
    await session.getAccess({ space: "s", reason: "refresh", replaceMediaConnection: false });
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ arrivalHandle: "handle-1", mediaProof: proof, replaceMediaConnection: false }));
    expect(session.mediaProof()).not.toBe(proof);
    expect(refreshed).toHaveBeenCalledOnce();
  });

  it("asks to replace the media connection on a retry", async () => {
    const { client, refresh } = fakeClient();
    const session = createPublicSpaceSession(client, { arrivalHandle: "handle-1", access: opaqueAccessGrant(1) });

    await session.getAccess({ space: "s", reason: "retry", replaceMediaConnection: true });
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ replaceMediaConnection: true }));
  });

  it("reports a failed refresh and keeps the old token", async () => {
    const onRefresh = vi.fn();
    const { client } = fakeClient({ refreshSpacePublicInviteAccess: vi.fn().mockRejectedValue(new Error("offline")) });
    const session = createPublicSpaceSession(client, { arrivalHandle: "handle-1", access: opaqueAccessGrant(1) }, { onRefresh });
    const proof = session.mediaProof();

    await expect(session.getAccess({ space: "s", reason: "refresh", replaceMediaConnection: false })).rejects.toThrow("offline");
    expect(onRefresh).toHaveBeenCalledWith("failed");
    expect(session.mediaProof()).toBe(proof);
  });

  it("leaves once, tolerates an arrival the server dropped, and refuses access afterwards", async () => {
    const { client, leave } = fakeClient({ leaveSpacePublicInviteArrival: vi.fn().mockRejectedValue({ status: 404 }) });
    const session = createPublicSpaceSession(client, { arrivalHandle: "handle-1", access: opaqueAccessGrant(1) });

    await session.leave();
    await session.leave();
    expect(client.leaveSpacePublicInviteArrival).toHaveBeenCalledOnce();
    await expect(session.getAccess({ space: "s", reason: "refresh", replaceMediaConnection: false })).rejects.toThrow("released");
    expect(leave).not.toHaveBeenCalled();
  });

  it("lets a failed leave be tried again", async () => {
    const leaveFirstFails = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const { client } = fakeClient({ leaveSpacePublicInviteArrival: leaveFirstFails });
    const session = createPublicSpaceSession(client, { arrivalHandle: "handle-1", access: opaqueAccessGrant(1) });

    await expect(session.leave()).rejects.toThrow("offline");
    await session.leave();
    expect(leaveFirstFails).toHaveBeenCalledTimes(2);
  });

  it("shares one request between leaves that overlap", async () => {
    const leaveOnce = vi.fn(async () => undefined);
    const { client } = fakeClient({ leaveSpacePublicInviteArrival: leaveOnce });
    const session = createPublicSpaceSession(client, { arrivalHandle: "handle-1", access: opaqueAccessGrant(1) });

    await Promise.all([session.leave(), session.leave()]);
    expect(leaveOnce).toHaveBeenCalledOnce();
  });
});
