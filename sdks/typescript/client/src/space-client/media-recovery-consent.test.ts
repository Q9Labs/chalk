import { expect, it, vi } from "vitest";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";
import { createConvergenceScenario, mediaStream, mediaTrack } from "../../tests/helpers/media-convergence";

it.each((["microphone", "camera"] as const).flatMap((source) => [false, true].map((stoppedBefore) => ({ source, stoppedBefore }))))("does not reverse $source consent revocation when Sync is replaced (already paused: $stoppedBefore)", async ({ source, stoppedBefore }) => {
  const first = createCoreTestPlatform();
  const next = createCoreTestPlatform();
  const track = Object.assign(mediaTrack(), { kind: source === "microphone" ? "audio" : "video" });
  const publication = { participantId: "participant-1", source, enabled: true, publicationId: "old-publication" };
  const command = vi.fn(async (enabled: boolean) => {
    next.emitSync({ ...next.sync.getSnapshot(), media: { projectionId: "replacement", sequence: 2, items: [{ ...publication, enabled }] } });
    return { operationId: "repair", name: "set_microphone_enabled" as const, serverOutcome: "satisfied" as const, mediaPlaneOutcome: "satisfied" as const };
  });
  let creations = 0;
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
    {
      ...first,
      dependencies: {
        ...first.dependencies,
        mediaDevices: { getUserMedia: async () => mediaStream(track) },
        createSyncClient: () => ({ ...(creations++ === 0 ? first.sync : next.sync), setMicrophoneEnabled: command, setCameraEnabled: command }),
      },
    },
  );
  try {
    await client.join({ microphone: source === "microphone", camera: source === "camera" });
    first.media.emit({ ...first.media.getSnapshot(), localTracks: [{ ...publication, track }] });
    first.emitSync({ ...first.sync.getSnapshot(), media: { projectionId: "media", sequence: 1, items: [publication] } });
    expect(client.getSnapshot().media.local[source].state).toBe("enabled");
    if (stoppedBefore) first.emitMediaPause({ source, revision: 2 });
    next.emitSync({ ...first.sync.getSnapshot(), connection: { phase: "idle" }, media: { projectionId: "replacement", sequence: 1, items: [{ ...publication, enabled: stoppedBefore }] } });
    first.emitSync({ ...first.sync.getSnapshot(), connection: { phase: "terminal", terminalReason: "fixture_disconnect" } });
    await vi.waitFor(() => expect(creations).toBe(2), { timeout: 3000 });
    await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(command.mock.calls.map(([enabled]) => enabled)).not.toContain(true);
    expect(track.enabled).toBe(false);
    expect(client.getSnapshot().media.local[source].state).toBe("disabled");
    await (source === "microphone" ? client.media.setMicrophoneEnabled(true) : client.media.setCameraEnabled(true));
    expect(command).toHaveBeenCalledExactlyOnceWith(true);
  } finally {
    client.dispose();
  }
});

it.each(["microphone", "camera"] as const)("does not resurrect unconfirmed %s consent after an offline stop", async (source) => {
  const platform = createCoreTestPlatform();
  const track = Object.assign(mediaTrack(), { kind: source === "microphone" ? "audio" : "video" });
  const command = vi.fn(async (_enabled: boolean) => ({ operationId: "repair", name: "set_microphone_enabled" as const, serverOutcome: "satisfied" as const, mediaPlaneOutcome: "satisfied" as const }));
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        mediaDevices: { getUserMedia: async () => mediaStream(track) },
        createSyncClient: () => ({ ...platform.sync, setMicrophoneEnabled: command, setCameraEnabled: command }),
      },
    },
  );
  try {
    await client.join({ microphone: source === "microphone", camera: source === "camera" });
    const publication = { participantId: "participant-1", source, enabled: true, publicationId: "old-publication" };
    platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ ...publication, track }] });
    platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "media", sequence: 1, items: [{ ...publication, enabled: false }] } });
    platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "recovering" } });
    await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
    // A host stop while disconnected cannot be replayed by the full snapshot.
    platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" }, media: { projectionId: "recovered", sequence: 1, items: [] } });
    await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(command.mock.calls.map(([enabled]) => enabled)).not.toContain(true);
    expect(track.enabled).toBe(false);
    expect(client.getSnapshot().media.local[source].state).toBe("disabled");
    await (source === "microphone" ? client.media.setMicrophoneEnabled(true) : client.media.setCameraEnabled(true));
    expect(command).toHaveBeenCalledExactlyOnceWith(true);
  } finally {
    client.dispose();
  }
});

it.each(["microphone", "camera"] as const)("does not send stale %s consent when pending capture finishes after recovery", async (source) => {
  const test = createConvergenceScenario(source);
  let finish = () => {};
  test.capture.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(mediaStream(test.track));
      }),
  );
  try {
    await test.client.join({ microphone: false, camera: false });
    const enabling = test.setEnabled(true);
    const result = expect(enabling).rejects.toBeDefined();
    await vi.waitFor(() => expect(test.capture).toHaveBeenCalledOnce());
    test.platform.emitSync({ ...test.platform.sync.getSnapshot(), connection: { phase: "recovering" } });
    await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("reconnecting"));
    test.platform.emitSync({ ...test.platform.sync.getSnapshot(), connection: { phase: "live" }, media: { projectionId: "recovered", sequence: 1, items: [] } });
    await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("live"));
    finish();
    await result;
    expect(test.command.mock.calls.map(([enabled]) => enabled)).not.toContain(true);
    expect(test.track.stop).toHaveBeenCalled();
  } finally {
    finish();
    test.client.dispose();
  }
});
