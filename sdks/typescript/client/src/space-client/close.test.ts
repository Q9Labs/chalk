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

  it("frees a client that never joined", async () => {
    const client = createSpaceClientForPlatform({ space: "test", getAccess: async () => opaqueAccessGrant(1) }, createCoreTestPlatform());
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("logs a failed leave and still frees the client", async () => {
    const warn = vi.fn();
    const client = createSpaceClientForPlatform({ space: "test", getAccess: async () => opaqueAccessGrant(1), logger: { warn } }, createCoreTestPlatform());
    await client.join({ microphone: false, camera: false });
    vi.spyOn(client, "leave").mockRejectedValue(new Error("socket already closed"));
    const dispose = vi.spyOn(client, "dispose");

    await expect(client.close()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("SpaceClient leave failed while closing", { message: "socket already closed" });
    expect(dispose).toHaveBeenCalledOnce();
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
