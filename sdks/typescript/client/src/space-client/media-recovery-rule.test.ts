import { describe, expect, it, vi } from "vitest";
import { createConvergenceScenario, enterRecovery } from "../../tests/helpers/media-convergence";

const sources = ["microphone", "camera"] as const;
type Source = (typeof sources)[number];
type Scenario = ReturnType<typeof createConvergenceScenario>;
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const live = (platform: Scenario["platform"]) => ({ ...platform.sync.getSnapshot(), connection: { phase: "live" as const } });
const mediaPhase = (platform: Scenario["platform"], phase: "recovering" | "live") =>
  platform.media.emit({ ...platform.media.getSnapshot(), connection: { phase, peerConnectionState: phase === "live" ? "connected" : "connecting", iceConnectionState: phase === "live" ? "connected" : "checking" }, failure: null });

// The media plane publishes after recovery and Sync lists it: a source the recovery kept wanted-on confirms.
function confirmPublication(platform: Scenario["platform"], track: MediaStreamTrack, source: Source): void {
  const publication = { participantId: "participant-1", source, enabled: true, publicationId: "publication-2" };
  platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ ...publication, track }] });
  platform.emitSync({ ...live(platform), media: { projectionId: "recovered", sequence: 1, items: [publication] } });
}

const hostStop = (source: Source, offRevision: number) => ({ participantId: "participant-1", source, enabled: false, publicationId: null, offReason: "host" as const, offRevision });

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
      confirmPublication(platform, track, source);
      expect(client.getSnapshot().media.local[source].state).toBe("enabled");
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
      confirmPublication(platform, track, source);
      expect(client.getSnapshot().media.local[source].state).toBe("enabled");
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
      confirmPublication(platform, track, source);
      expect(client.getSnapshot().media.local[source].state).toBe("enabled");
      expect(setLocalSourceIntent).not.toHaveBeenCalledWith(source, false, "sync_recovery_loss");
      expect(closeForcedLocalPublication).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  // The host mutes while the device is gone. Sync tells the client in one of two ways, and recovery pauses on either.
  it.each(sources)("a host stop replayed while the %s device was gone pauses it", async (source) => {
    const { client, platform, track, setEnabled, setLocalSourceIntent } = recoveryScenario(source);
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      await enterRecovery({ platform, client });
      platform.emitMediaPause({ source, revision: 9 });
      platform.emitSync({ ...live(platform), media: { projectionId: "recovered", sequence: 0, items: [] } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      await vi.waitFor(() => expect(track.enabled).toBe(false));
      expect(client.getSnapshot().media.local[source].state).toBe("disabled");
      expect(setLocalSourceIntent).toHaveBeenCalledWith(source, false, "moderation_pause");
    } finally {
      client.dispose();
    }
  });

  it.each(sources)("a host stop in the recovered snapshot pauses the %s source when replay was lost", async (source) => {
    const { client, platform, track, setEnabled, setLocalSourceIntent } = recoveryScenario(source);
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      await enterRecovery({ platform, client });
      platform.emitSync({ ...live(platform), media: { projectionId: "recovered", sequence: 0, items: [hostStop(source, 9)] } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      await vi.waitFor(() => expect(track.enabled).toBe(false));
      expect(client.getSnapshot().media.local[source].state).toBe("disabled");
      expect(setLocalSourceIntent).toHaveBeenCalledWith(source, false, "moderation_pause");
    } finally {
      client.dispose();
    }
  });

  it.each(sources)("a host stop during %s recovery, after the snapshot, pauses it", async (source) => {
    const { client, platform, track, setEnabled } = recoveryScenario(source);
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      await enterRecovery({ platform, client });
      platform.emitSync({ ...live(platform), media: { projectionId: "recovered", sequence: 0, items: [] } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      expect(track.enabled).toBe(true);
      platform.emitMediaPause({ source, revision: 9 });
      await vi.waitFor(() => expect(track.enabled).toBe(false));
    } finally {
      client.dispose();
    }
  });

  // The stop is not newer than the user's own On, so the user's later intent wins.
  it.each(sources)("a host stop the %s intent already answered does not pause it again", async (source) => {
    const { client, platform, track, setEnabled, setLocalSourceIntent } = recoveryScenario(source);
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      platform.emitMediaPause({ source, revision: 20 });
      await vi.waitFor(() => expect(track.enabled).toBe(false));
      await setEnabled(true);
      setLocalSourceIntent.mockClear();
      await enterRecovery({ platform, client });
      platform.emitSync({ ...live(platform), media: { projectionId: "recovered", sequence: 0, items: [hostStop(source, 20)] } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      await tick(20);
      expect(setLocalSourceIntent).not.toHaveBeenCalledWith(source, false, expect.anything());
    } finally {
      client.dispose();
    }
  });

  it.each(sources)("a stop newer than the %s intent pauses it", async (source) => {
    const { client, platform, track, setEnabled } = recoveryScenario(source);
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      platform.emitMediaPause({ source, revision: 20 });
      await vi.waitFor(() => expect(track.enabled).toBe(false));
      await setEnabled(true);
      await enterRecovery({ platform, client });
      platform.emitSync({ ...live(platform), media: { projectionId: "recovered", sequence: 0, items: [hostStop(source, 21)] } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      await vi.waitFor(() => expect(track.enabled).toBe(false));
    } finally {
      client.dispose();
    }
  });

  // The user turns the source off and on again while the session is gone; the stop is newer than that last intent, so it still pauses it.
  it.each(sources)("a host stop newer than a %s intent made during the reconnect pauses that intent", async (source) => {
    const { client, platform, track, setEnabled, setLocalSourceIntent } = recoveryScenario(source);
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      await enterRecovery({ platform, client });
      await setEnabled(false);
      const again = setEnabled(true).catch(() => undefined);
      platform.emitSync({ ...live(platform), media: { projectionId: "recovered", sequence: 0, items: [hostStop(source, 9)] } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      await again;
      await vi.waitFor(() => expect(setLocalSourceIntent).toHaveBeenCalledWith(source, false, "moderation_pause"));
      expect(track.enabled).toBe(false);
    } finally {
      client.dispose();
    }
  });

  // A device pause the Sync held for this device is the device's own answer, not the host's.
  it.each(sources)("a device pause on the %s item is no evidence the host turned it off", async (source) => {
    const { client, platform, track, setEnabled } = recoveryScenario(source);
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      await enterRecovery({ platform, client });
      const item = { participantId: "participant-1", source, enabled: false, publicationId: null, offReason: "self" as const };
      platform.emitSync({ ...live(platform), media: { projectionId: "recovered", sequence: 0, items: [item] } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      await tick(20);
      expect(track.enabled).toBe(true);
    } finally {
      client.dispose();
    }
  });

  // The bounded variant: with no stop evidence, a drop under LONG_DROP_MS resumes without a tap, and a drop of that length or more is a turn-off.
  describe("after Sync lost the publication with no stop evidence", () => {
    const longDropMs = 60_000;

    async function dropAndRecover(source: Source, downMs: number, items: readonly object[] = [], duringDrop: (setEnabled: Scenario["setEnabled"]) => Promise<unknown> = async () => undefined) {
      const heardAt = Date.now();
      let now = heardAt;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const scenario = recoveryScenario(source, { sync: { lastHeardAt: () => heardAt } });
      const { client, platform, setEnabled } = scenario;
      try {
        await client.join({ microphone: false, camera: false });
        await setEnabled(true);
        await enterRecovery({ platform, client });
        const user = duringDrop(setEnabled);
        now = heardAt + downMs;
        platform.emitSync({ ...live(platform), media: { projectionId: "recovered", sequence: 0, items } });
        await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
        await user;
        await tick(20);
      } catch (cause) {
        client.dispose();
        clock.mockRestore();
        throw cause;
      }
      return {
        ...scenario,
        finish: () => {
          client.dispose();
          clock.mockRestore();
        },
      };
    }

    it.each(sources)("%s: a drop of 59.9 s keeps it on and resumes without a tap", async (source) => {
      const { client, platform, track, setLocalSourceIntent, finish } = await dropAndRecover(source, longDropMs - 100);
      try {
        expect(track.enabled).toBe(true);
        confirmPublication(platform, track, source);
        expect(client.getSnapshot().media.local[source].state).toBe("enabled");
        expect(setLocalSourceIntent).not.toHaveBeenCalledWith(source, false, expect.anything());
      } finally {
        finish();
      }
    });

    it.each(sources)("%s: a drop of 60 s turns it off like a tap", async (source) => {
      const { client, track, setLocalSourceIntent, finish } = await dropAndRecover(source, longDropMs);
      try {
        expect(track.enabled).toBe(false);
        expect(client.getSnapshot().media.local[source].state).toBe("disabled");
        expect(setLocalSourceIntent).toHaveBeenCalledWith(source, false, "user_pause");
      } finally {
        finish();
      }
    });

    it.each(sources)("%s: a long drop leaves it on when Sync still lists the publication", async (source) => {
      const item = { participantId: "participant-1", source, enabled: true, publicationId: "publication-1" };
      const { client, platform, track, setLocalSourceIntent, finish } = await dropAndRecover(source, longDropMs * 5, [item]);
      try {
        expect(track.enabled).toBe(true);
        confirmPublication(platform, track, source);
        expect(client.getSnapshot().media.local[source].state).toBe("enabled");
        expect(setLocalSourceIntent).not.toHaveBeenCalledWith(source, false, "user_pause");
      } finally {
        finish();
      }
    });

    it.each(sources)("%s: a host stop newer than the intent pauses it whatever the drop length", async (source) => {
      const { track, setLocalSourceIntent, finish } = await dropAndRecover(source, 1_000, [hostStop(source, 9)]);
      try {
        await vi.waitFor(() => expect(setLocalSourceIntent).toHaveBeenCalledWith(source, false, "moderation_pause"));
        expect(track.enabled).toBe(false);
      } finally {
        finish();
      }
    });

    // The cutoff judges the intent that existed when recovery began, so a tap during the drop is the user's new word.
    const offThenOn = async (setEnabled: Scenario["setEnabled"]) => {
      await setEnabled(false);
      await setEnabled(true).catch(() => undefined);
    };

    it.each(sources.flatMap((source) => [longDropMs - 100, longDropMs, longDropMs * 2].map((downMs) => ({ source, downMs }))))("$source: a turn-off and turn-on during a drop of $downMs ms keeps the new on and applies it once", async ({ source, downMs }) => {
      const { command, setLocalSourceIntent, finish } = await dropAndRecover(source, downMs, [], offThenOn);
      try {
        expect(command.mock.calls.filter(([enabled]) => enabled === true)).toHaveLength(2);
        const intents = setLocalSourceIntent.mock.calls;
        expect(intents.at(-1)).toEqual([source, true]);
        expect(intents.filter(([, enabled]) => enabled === false)).toHaveLength(1);
      } finally {
        finish();
      }
    });

    it.each(sources.flatMap((source) => [longDropMs - 100, longDropMs].map((downMs) => ({ source, downMs }))))("$source: a tap off during a drop of $downMs ms stays off", async ({ source, downMs }) => {
      const { client, track, command, finish } = await dropAndRecover(source, downMs, [], (setEnabled) => setEnabled(false));
      try {
        expect(track.enabled).toBe(false);
        expect(client.getSnapshot().media.local[source].state).toBe("disabled");
        expect(command.mock.calls.filter(([enabled]) => enabled === true)).toHaveLength(1);
      } finally {
        finish();
      }
    });
  });
});
