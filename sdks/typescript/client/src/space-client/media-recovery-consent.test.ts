import { expect, it, vi } from "vitest";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";
import { mediaStream, mediaTrack } from "../../tests/helpers/media-convergence";
import { observeMicrophonePublication } from "./terminal.test.helpers";

it("does not automatically reverse an offline host mute when Sync must be replaced", async () => {
  const first = createCoreTestPlatform();
  const next = createCoreTestPlatform();
  const track = mediaTrack();
  const command = vi.fn(async (enabled: boolean) => {
    next.emitSync({ ...next.sync.getSnapshot(), media: { projectionId: "replacement", sequence: 2, items: [{ participantId: "participant-1", source: "microphone", enabled, publicationId: "old-publication" }] } });
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
        createSyncClient: () => ({ ...(creations++ === 0 ? first.sync : next.sync), setMicrophoneEnabled: command }),
      },
    },
  );
  try {
    await client.join({ microphone: true, camera: false });
    observeMicrophonePublication(first, track);
    expect(client.getSnapshot().media.local.microphone.state).toBe("enabled");
    next.emitSync({ ...first.sync.getSnapshot(), connection: { phase: "idle" }, media: { projectionId: "replacement", sequence: 1, items: [{ participantId: "participant-1", source: "microphone", enabled: false, publicationId: "old-publication" }] } });
    first.emitSync({ ...first.sync.getSnapshot(), connection: { phase: "terminal", terminalReason: "fixture_disconnect" } });
    await vi.waitFor(() => expect(creations).toBe(2), { timeout: 3000 });
    await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(command.mock.calls.map(([enabled]) => enabled)).not.toContain(true);
  } finally {
    client.dispose();
  }
});

it("does not resurrect an unconfirmed publication after an offline host mute and an in-place recovery", async () => {
  const platform = createCoreTestPlatform();
  const track = mediaTrack();
  const command = vi.fn(async (_enabled: boolean) => ({ operationId: "repair", name: "set_microphone_enabled" as const, serverOutcome: "satisfied" as const, mediaPlaneOutcome: "satisfied" as const }));
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        mediaDevices: { getUserMedia: async () => mediaStream(track) },
        createSyncClient: () => ({ ...platform.sync, setMicrophoneEnabled: command }),
      },
    },
  );
  try {
    await client.join({ microphone: true, camera: false });
    const publication = { participantId: "participant-1", source: "microphone" as const, enabled: true, publicationId: "old-publication" };
    platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ ...publication, track }] });
    platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "media", sequence: 1, items: [{ ...publication, enabled: false }] } });
    platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "recovering" } });
    await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
    // A host stop while disconnected cannot be replayed by the full snapshot.
    platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" }, media: { projectionId: "recovered", sequence: 1, items: [] } });
    await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(command.mock.calls.map(([enabled]) => enabled)).not.toContain(true);
  } finally {
    client.dispose();
  }
});
