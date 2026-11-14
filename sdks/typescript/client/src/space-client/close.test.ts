import { describe, expect, it, vi } from "vitest";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { reloadRejoinPresence } from "./reload-rejoin";
import { sessionExit } from "./session-exit";
import { createSpaceClientForPlatform } from "./space-client";
import type { ConnectionSlice, SpaceSnapshot } from "./types";

describe("SpaceClient.close", () => {
  it("leaves a joined client, then frees it once however often it is called", async () => {
    const client = createSpaceClientForPlatform({ space: "test", getAccess: async () => opaqueAccessGrant(1) }, createCoreTestPlatform());
    await client.join({ microphone: false, camera: false });
    expect(client.getSnapshot().connection.status).toBe("live");

    const first = client.close();
    const second = client.close();
    expect(second).toBe(first);
    await first;
    expect(client.getSnapshot().connection.status).toBe("left");
  });

  it("ends in left with the unconfirmed-leave error, so a caller can tell the seat may still be held", async () => {
    const platform = createCoreTestPlatform();
    const client = createSpaceClientForPlatform({ space: "test", getAccess: async () => opaqueAccessGrant(1) }, { ...platform, dependencies: { ...platform.dependencies, cancelPendingAdmission: async () => false } });
    await client.join({ microphone: false, camera: false });
    vi.spyOn(platform.sync, "leave").mockRejectedValue(new Error("offline"));

    await expect(client.close()).resolves.toBeUndefined();
    expect(client.getSnapshot().connection.status).toBe("left");
    expect(client.getSnapshot().connection.lastError?.code).toBe("connection.leave_unconfirmed");
  });

  it("frees a client that never joined", async () => {
    const client = createSpaceClientForPlatform({ space: "test", getAccess: async () => opaqueAccessGrant(1) }, createCoreTestPlatform());
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("logs a failed leave and still frees the client", async () => {
    const warnings: unknown[][] = [];
    const client = createSpaceClientForPlatform({ space: "test", getAccess: async () => opaqueAccessGrant(1), logger: { warn: (...args: unknown[]) => warnings.push(args) } }, createCoreTestPlatform());
    await client.join({ microphone: false, camera: false });
    vi.spyOn(client, "leave").mockRejectedValue(new Error("socket already closed"));
    const dispose = client.dispose.bind(client);
    let disposals = 0;
    client.dispose = () => {
      disposals += 1;
      return dispose();
    };

    await expect(client.close()).resolves.toBeUndefined();
    expect(warnings).toEqual([["SpaceClient leave failed while closing", { message: "socket already closed" }]]);
    expect(disposals).toBe(1);
  });
});

describe("sessionExit", () => {
  const connection = (patch: Partial<ConnectionSlice>): ConnectionSlice => ({ status: "live", episode: null, lastError: null, episodeEnded: false, removedByHost: false, ...patch });

  it.each([
    ["an ended Episode", connection({ episodeEnded: true }), "episode-ended"],
    ["a removal by the host", connection({ removedByHost: true }), "removed"],
    ["a failed connection", connection({ status: "failed" }), "failed"],
    ["a failure that says the Episode ended", connection({ status: "failed", lastError: { code: "episode.ended" } as ConnectionSlice["lastError"] }), "episode-ended"],
    ["a live call", connection({}), undefined],
    ["the participant's own leave", connection({ status: "left" }), undefined],
  ])("maps %s", (_name, slice, expected) => {
    expect(sessionExit(slice)).toBe(expected);
  });
});

describe("reloadRejoinPresence", () => {
  it("reads the name and device state from the snapshot, falling back to the given name", () => {
    const snapshot = { self: { displayName: null }, media: { local: { microphone: { state: "enabled" }, camera: { state: "disabled" } } } } as unknown as SpaceSnapshot;
    expect(reloadRejoinPresence(snapshot, "Guest")).toEqual({ displayName: "Guest", microphone: true, camera: false });
  });
});
