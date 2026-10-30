import { expect, it, vi } from "vitest";
import { otherDevices } from "./same-identity";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";
import { stream, track } from "./capture.test.helpers";
import type { V1Presence } from "../sync/v1-types";

const presence = (participantId: string, identityId?: string, state: V1Presence["state"] = "connected"): V1Presence => ({ participantId, identityId, state, speaking: false, activeSpeaker: false });
it("matches a verified person identity only across live distinct seats", () => {
  const seats = [presence("desktop", "person"), presence("phone", "person"), presence("gone", "person", "disconnected"), presence("someone", "other"), presence("anonymous")];
  expect(otherDevices(seats, "desktop").map((item) => item.participantId)).toEqual(["phone"]);
  expect(otherDevices(seats, "anonymous")).toEqual([]);
  expect(otherDevices(seats, null)).toEqual([]);
});
it.each([true, false])("joining with another device microphone %s preserves that device and starts the new mic safely", async (enabled) => {
  const platform = createCoreTestPlatform();
  const mic = track("audio");
  const published: MediaStream[] = [];
  const start = vi.fn(async (stream: MediaStream, beforePublish?: () => Promise<MediaStream>) => {
    published.push(beforePublish ? await beforePublish() : stream);
  });
  platform.emitSync({
    ...platform.sync.getSnapshot(),
    presence: { projectionId: "presence", sequence: 0, items: [presence("participant-1", "person"), presence("desktop", "person")] },
    media: { projectionId: "media", sequence: 0, items: [{ participantId: "desktop", source: "microphone", enabled, publicationId: enabled ? "publication" : null }] },
  });
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
    { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia: async () => stream([mic]) }, createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), start }) } },
  );
  try {
    await client.join({ microphone: true, camera: false });
    expect(published[0]?.getTracks().filter((track) => track.kind === "audio")).toHaveLength(enabled ? 0 : 1);
    expect(client.getSnapshot().media.microphoneMutedByOtherDevice).toBe(enabled);
    expect(platform.sync.getSnapshot().media?.items[0]?.enabled).toBe(enabled);
  } finally {
    client.dispose();
  }
});
it("stops a microphone muted while admission is pending before handing tracks to media", async () => {
  const platform = createCoreTestPlatform();
  const mic = track("audio");
  let release = () => {};
  const admission = new Promise<void>((resolve) => {
    release = resolve;
  });
  const getAccess = vi.fn(async () => {
    await admission;
    return opaqueAccessGrant("test");
  });
  const start = vi.fn(async (_stream: MediaStream) => undefined);
  const client = createSpaceClientForPlatform({ space: "space-1", getAccess }, { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia: async () => stream([mic]) }, createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), start }) } });
  try {
    const joining = client.join({ microphone: true, camera: false });
    await vi.waitFor(() => expect(getAccess).toHaveBeenCalled());
    const muted = client.media.setMicrophoneEnabled(false);
    release();
    await joining;
    await muted;
    expect(start.mock.calls[0]?.[0].getTracks().filter((track) => track.kind === "audio")).toHaveLength(0);
    expect(mic.stop).toHaveBeenCalled();
  } finally {
    release();
    client.dispose();
  }
});
it("releases the pre-publication wait when Sync fails before becoming live", async () => {
  const platform = createCoreTestPlatform();
  let failSync = (_error: Error) => {};
  const syncStart = new Promise<void>((_resolve, reject) => {
    failSync = reject;
  });
  const publicationGateReleased = vi.fn();
  const start = vi.fn(async (_stream: MediaStream, beforePublish?: () => Promise<MediaStream>) => {
    await beforePublish?.();
    publicationGateReleased();
  });
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        createConnectionReporter: () => undefined,
        createSyncClient: () => ({ ...platform.sync, start: () => syncStart }),
        createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), start, stop: () => platform.media.emit({ ...platform.media.getSnapshot(), connection: { ...platform.media.getSnapshot().connection, phase: "stopped" } }) }),
      },
    },
  );
  try {
    const joining = client.join({ microphone: false, camera: false });
    const failed = expect(joining).rejects.toBeDefined();
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    failSync(new Error("Sync startup failed"));
    await failed;
    await vi.waitFor(() => expect(publicationGateReleased).toHaveBeenCalledOnce());
  } finally {
    client.dispose();
  }
});
