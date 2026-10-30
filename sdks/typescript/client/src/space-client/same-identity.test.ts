import { expect, it, vi } from "vitest";
import { otherDevices } from "./same-identity";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";
import { stream, track } from "./capture.test.helpers";
import { control } from "./terminal.test.helpers";
import type { V1Presence } from "../sync/v1-types";

const deviceControl = { ...control, participants: ["participant-1", "desktop"].map((participantId) => ({ participantId, displayName: "Member", handRaised: false, admissionRevision: 1, role: "owner" as const, eligibleRoles: [], capabilities: [] })) };
const presence = (participantId: string, identityId?: string, state: V1Presence["state"] = "connected"): V1Presence => ({ participantId, identityId, state, speaking: false, activeSpeaker: false });
it("matches a verified person identity across distinct admitted seats even through presence loss", () => {
  const seats = [presence("desktop", "person"), presence("phone", "person"), presence("gone", "person", "disconnected"), presence("someone", "other"), presence("anonymous")];
  expect(otherDevices(seats, "desktop").map((item) => item.participantId)).toEqual(["phone", "gone"]);
  expect(otherDevices(seats, "anonymous")).toEqual([]);
  expect(otherDevices(seats, null)).toEqual([]);
});
it.each([true, false].flatMap((enabled) => [true, false].map((pending) => ({ enabled, pending }))))("joining with sibling microphone $enabled and pending admission $pending starts the mic safely", async ({ enabled, pending }) => {
  const platform = createCoreTestPlatform();
  const mic = track("audio");
  const published: MediaStream[] = [];
  const start = vi.fn(async (stream: MediaStream, beforePublish?: () => Promise<MediaStream>) => {
    published.push(beforePublish ? await beforePublish() : stream);
  });
  platform.emitSync({
    ...platform.sync.getSnapshot(),
    participantIdentityId: pending ? "person" : undefined,
    control: pending ? { ...deviceControl, participants: deviceControl.participants.filter((seat) => seat.participantId !== "participant-1") } : deviceControl,
    presence: { projectionId: "presence", sequence: 0, items: pending ? [presence("desktop", "person", "disconnected")] : [presence("participant-1", "person"), presence("desktop", "person")] },
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

function knownDevicesPlatform() {
  const platform = createCoreTestPlatform();
  platform.emitSync({
    ...platform.sync.getSnapshot(),
    control: deviceControl,
    presence: { projectionId: "presence", sequence: 0, items: [presence("participant-1", "person"), { ...presence("desktop", "person"), deviceType: "computer" }] },
    media: { projectionId: "media", sequence: 0, items: [{ participantId: "desktop", source: "microphone", enabled: true, publicationId: "mic" }] },
  });
  return platform;
}

it("retains seat identity and device type through presence loss and replica recovery, then clears them at a durable leave", async () => {
  const platform = knownDevicesPlatform();
  const client = createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, platform);
  const sibling = () => client.getSnapshot().participants.roster.find((item) => item.participantId === "desktop");
  try {
    await client.join({ microphone: false, camera: false });
    platform.emitSync({ ...platform.sync.getSnapshot(), presence: { projectionId: "presence", sequence: 1, items: [presence("participant-1", "person")] } });
    expect(sibling()).toMatchObject({ identityId: "person", deviceType: "computer", presence: { state: "unknown" }, media: { microphone: "active" } });
    platform.emitSync({ ...platform.sync.getSnapshot(), control: null });
    expect(sibling()).toMatchObject({ identityId: "person", deviceType: "computer" });
    platform.emitSync({ ...platform.sync.getSnapshot(), control: { ...deviceControl, participants: deviceControl.participants.filter((item) => item.participantId !== "desktop") } });
    expect(sibling()).toBeUndefined();
    platform.emitSync({ ...platform.sync.getSnapshot(), control: { ...deviceControl, participants: deviceControl.participants.map((item) => ({ ...item, admissionRevision: 2 })) } });
    expect(sibling()?.identityId).toBeUndefined();
    expect(sibling()?.deviceType).toBeUndefined();
    platform.emitSync({ ...platform.sync.getSnapshot(), control: { ...deviceControl, status: "ended" } });
    expect(client.getSnapshot().participants.roster).toEqual([]);
  } finally {
    client.dispose();
  }
});

it("does not carry an old buffered hint into a new admission of the same participant ID", async () => {
  const platform = knownDevicesPlatform();
  const client = createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, platform);
  try {
    await client.join({ microphone: false, camera: false });
    platform.emitSync({ ...platform.sync.getSnapshot(), control: { ...deviceControl, participants: deviceControl.participants.map((item) => ({ ...item, admissionRevision: 2 })) } });
    expect(client.getSnapshot().participants.roster.every((item) => item.identityId === undefined)).toBe(true);
    platform.emitSync({ ...platform.sync.getSnapshot(), presence: { projectionId: "presence", sequence: 1, items: [presence("participant-1", "person"), presence("desktop", "different-person")] } });
    expect(client.getSnapshot().participants.roster.find((item) => item.participantId === "desktop")?.identityId).toBe("different-person");
  } finally {
    client.dispose();
  }
});

it("starts muted when a known sibling is still sending after disappearing from presence before publication", async () => {
  const platform = knownDevicesPlatform();
  const mic = track("audio");
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let published: MediaStream | undefined;
  const start = vi.fn(async (_stream: MediaStream, beforePublish?: () => Promise<MediaStream>) => {
    await held;
    published = await beforePublish?.();
  });
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
    { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia: async () => stream([mic]) }, createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), start }) } },
  );
  try {
    const joining = client.join({ microphone: true, camera: false });
    await vi.waitFor(() => expect(client.getSnapshot().participants.roster.find((item) => item.participantId === "desktop")?.identityId).toBe("person"));
    platform.emitSync({ ...platform.sync.getSnapshot(), presence: { projectionId: "presence", sequence: 1, items: [presence("participant-1", "person")] } });
    release();
    await joining;
    expect(published?.getTracks()).toHaveLength(0);
    expect(mic.stop).toHaveBeenCalled();
    expect(client.getSnapshot().media.microphoneMutedByOtherDevice).toBe(true);
  } finally {
    release();
    client.dispose();
  }
});
