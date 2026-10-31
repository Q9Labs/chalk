import { describe, expect, it, vi } from "vitest";
import { createConvergenceScenario, enterRecovery } from "../../tests/helpers/media-convergence";

const sources = ["microphone", "camera"] as const;
type Source = (typeof sources)[number];
type Scenario = ReturnType<typeof createConvergenceScenario>;
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const live = (platform: Scenario["platform"]) => ({ ...platform.sync.getSnapshot(), connection: { phase: "live" as const } });
const mediaPhase = (platform: Scenario["platform"], phase: "recovering" | "live") =>
  platform.media.emit({ ...platform.media.getSnapshot(), connection: { phase, peerConnectionState: phase === "live" ? "connected" : "connecting", iceConnectionState: phase === "live" ? "connected" : "checking" }, failure: null });

function recoveryScenario(source: Source, overrides: Parameters<typeof createConvergenceScenario>[1] = {}) {
  const setLocalSourceIntent = vi.fn(async () => {});
  const closeForcedLocalPublication = vi.fn(async () => undefined);
  const scenario = createConvergenceScenario(source, { ...overrides, media: { setLocalSourceIntent, closeForcedLocalPublication, ...overrides.media } });
  return { ...scenario, setLocalSourceIntent, closeForcedLocalPublication };
}

describe("recovery keeps a wanted-on source unless Sync turned it off", () => {
  // Trace A: Sync holds the grant but lists no publication yet, and the session reconnects before the first publication exists.
  it.each(sources)("A: a reconnect before the first %s publication exists does not pause it", async (source) => {
    const { client, platform, track, setEnabled, setLocalSourceIntent, closeForcedLocalPublication } = recoveryScenario(source);
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "before", sequence: 1, items: [] } });
      await enterRecovery({ platform, client });
      platform.emitSync({ ...live(platform), media: { projectionId: "recovered", sequence: 0, items: [] } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      await tick(20);
      expect(track.enabled).toBe(true);
      expect(client.getSnapshot().media.local[source].state).not.toBe("disabled");
      expect(setLocalSourceIntent).not.toHaveBeenCalledWith(source, false, "sync_recovery_loss");
      expect(closeForcedLocalPublication).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  // Trace B: the user turns the source on while Sync is healthy, only the media plane recovers, and the first Sync item is still missing at restore.
  it.each(sources)("B: a media-only recovery during a pending %s enable does not revoke it", async (source) => {
    const release = Promise.withResolvers<void>();
    const held = vi.fn(async (_enabled: boolean) => {
      await release.promise;
      return { operationId: "target", name: "set_microphone_enabled" as const, serverOutcome: "satisfied" as const, mediaPlaneOutcome: "satisfied" as const };
    });
    const { client, platform, track, setEnabled, setLocalSourceIntent } = recoveryScenario(source, { sync: { setMicrophoneEnabled: held, setCameraEnabled: held } });
    try {
      await client.join({ microphone: false, camera: false });
      const enabling = setEnabled(true).then(
        () => "enabled",
        (cause: unknown) => cause,
      );
      await vi.waitFor(() => expect(held).toHaveBeenCalledWith(true));
      mediaPhase(platform, "recovering");
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
      await tick(400);
      mediaPhase(platform, "live");
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      release.resolve();
      expect(await enabling).toBe("enabled");
      expect(track.enabled).toBe(true);
      expect(client.getSnapshot().media.local[source].state).not.toBe("disabled");
      expect(setLocalSourceIntent).not.toHaveBeenCalledWith(source, false, "sync_recovery_loss");
    } finally {
      release.resolve();
      client.dispose();
    }
  });

  // Trace C: Sync marked the publisher's own publication dead on purpose (tombstone), and the publisher reconnects before the republish is admitted.
  it.each(sources)("C: a reconnect after a dead mark and before the %s republish does not pause it", async (source) => {
    const { client, platform, track, setEnabled, setLocalSourceIntent, closeForcedLocalPublication } = recoveryScenario(source);
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      const item = { participantId: "participant-1", source };
      platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "live", sequence: 1, items: [{ ...item, enabled: true, publicationId: "publication-1" }] } });
      platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "live", sequence: 2, items: [{ ...item, enabled: false, publicationId: null }] } });
      await enterRecovery({ platform, client });
      platform.emitSync({ ...live(platform), media: { projectionId: "recovered", sequence: 0, items: [{ ...item, enabled: false, publicationId: null }] } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      await tick(20);
      expect(track.enabled).toBe(true);
      expect(client.getSnapshot().media.local[source].state).not.toBe("disabled");
      expect(setLocalSourceIntent).not.toHaveBeenCalledWith(source, false, "sync_recovery_loss");
      expect(closeForcedLocalPublication).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });
});
