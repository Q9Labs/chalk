import { describe, expect, it, vi } from "vitest";
import { createConvergenceScenario, enterRecovery, mediaStream, mediaTrack } from "../../tests/helpers/media-convergence";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

// The decided media control rule: turning media off is the device's decision and never fails.
// The device stops capture at once, tells Sync, and resends until Sync accepts the off.
// Turning media on is Sync's decision: the UI shows on only after Sync does.
const sources = ["microphone", "camera", "screen"] as const;
type Source = (typeof sources)[number];
type Platform = ReturnType<typeof createCoreTestPlatform>;
const receipt = { operationId: "off", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" } as const;
const lost = () => new Error("the send to Sync was lost");
const drain = () => new Promise((resolve) => setTimeout(resolve, 30));
function project(platform: Platform, source: Source, enabled: boolean, track?: MediaStreamTrack) {
  const publication = { participantId: "participant-1", source, enabled: true, publicationId: "publication-1" };
  if (enabled && track) platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ ...publication, track }] });
  platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "media", sequence: (platform.sync.getSnapshot().media?.sequence ?? 0) + 1, items: [{ participantId: "participant-1", source, enabled, publicationId: enabled ? "publication-1" : null }] } });
}
const sentOffs = (command: ReturnType<typeof createConvergenceScenario>["command"]) => command.mock.calls.filter(([enabled]) => !enabled).length;
const uiState = (scenario: ReturnType<typeof createConvergenceScenario>, source: Source) => {
  const media = scenario.client.getSnapshot().media;
  return (source === "screen" ? media.screenShare : media.local[source]).state;
};
const projectOn = (scenario: ReturnType<typeof createConvergenceScenario>, source: Source) => project(scenario.platform, source, true, scenario.track);

/** Source is on for Sync and the device, then the user turns it off and the send to Sync is lost while the link stays up. */
async function liveThenLostOff(source: Source) {
  const scenario = createConvergenceScenario(source);
  await scenario.client.join({ microphone: false, camera: false });
  await scenario.setEnabled(true);
  projectOn(scenario, source);
  await vi.waitFor(() => expect(uiState(scenario, source)).toBe("enabled"));
  scenario.command.mockRejectedValueOnce(lost());
  await expect(scenario.setEnabled(false)).rejects.toBeDefined();
  // Screen share ends by stopping its track; its UI state follows the Sync projection, which is outside this rule's scope.
  if (source === "screen") expect(scenario.track.stop).toHaveBeenCalled();
  else expect(uiState(scenario, source)).toBe("disabled");
  expect(sentOffs(scenario.command)).toBe(1);
  return scenario;
}

describe("an off that never reached Sync stays owed", () => {
  it.each(sources)("resends a lost %s off after a reconnect (P2)", async (source) => {
    const scenario = await liveThenLostOff(source);
    try {
      await enterRecovery(scenario);
      // The recovered snapshot still shows the source on: Sync never heard the off.
      scenario.platform.emitSync({ ...scenario.platform.sync.getSnapshot(), connection: { phase: "live" } });
      await vi.waitFor(() => expect(scenario.client.getSnapshot().connection.status).toBe("live"));
      await vi.waitFor(() => expect(sentOffs(scenario.command)).toBe(2));
      await drain();
      expect(sentOffs(scenario.command)).toBe(2);
      expect(scenario.command.mock.calls.filter(([enabled]) => enabled)).toHaveLength(1);
      if (source !== "screen") expect(uiState(scenario, source)).toBe("disabled");
    } finally {
      scenario.client.dispose();
    }
  });

  it.each(sources)("resends a lost %s off when the next Sync snapshot shows it on, without a reconnect (P4)", async (source) => {
    const scenario = await liveThenLostOff(source);
    try {
      projectOn(scenario, source);
      await vi.waitFor(() => expect(sentOffs(scenario.command)).toBe(2));
      await drain();
      expect(sentOffs(scenario.command)).toBe(2);
      // Sync accepted the resend, so later snapshots do not repeat it.
      project(scenario.platform, source, false);
      await drain();
      expect(sentOffs(scenario.command)).toBe(2);
      if (source !== "screen") expect(uiState(scenario, source)).toBe("disabled");
    } finally {
      scenario.client.dispose();
    }
  });

  // Screen share also resends on its own projection check, so its send count is not exact.
  it.each(["microphone", "camera"] as const)("keeps resending a %s off until Sync accepts one", async (source) => {
    const scenario = await liveThenLostOff(source);
    try {
      scenario.command.mockRejectedValueOnce(lost());
      projectOn(scenario, source);
      await vi.waitFor(() => expect(sentOffs(scenario.command)).toBe(2));
      projectOn(scenario, source);
      await vi.waitFor(() => expect(sentOffs(scenario.command)).toBe(3));
      await drain();
      projectOn(scenario, source);
      await drain();
      expect(sentOffs(scenario.command)).toBe(3);
    } finally {
      scenario.client.dispose();
    }
  });

  it.each(sources)("does not resend a %s off that Sync accepted", async (source) => {
    const scenario = createConvergenceScenario(source);
    try {
      await scenario.client.join({ microphone: false, camera: false });
      await scenario.setEnabled(true);
      projectOn(scenario, source);
      scenario.command.mockResolvedValue(receipt);
      await scenario.setEnabled(false);
      project(scenario.platform, source, false);
      await enterRecovery(scenario);
      scenario.platform.emitSync({ ...scenario.platform.sync.getSnapshot(), connection: { phase: "live" } });
      await vi.waitFor(() => expect(scenario.client.getSnapshot().connection.status).toBe("live"));
      project(scenario.platform, source, false);
      await drain();
      expect(sentOffs(scenario.command)).toBe(1);
    } finally {
      scenario.client.dispose();
    }
  });
});

describe("the on path still belongs to Sync", () => {
  it.each(sources)("shows %s as on only after Sync shows it, and never captures a muted source after a reconnect", async (source) => {
    const scenario = await liveThenLostOff(source);
    try {
      await enterRecovery(scenario);
      scenario.platform.emitSync({ ...scenario.platform.sync.getSnapshot(), connection: { phase: "live" } });
      await vi.waitFor(() => expect(scenario.client.getSnapshot().connection.status).toBe("live"));
      await vi.waitFor(() => expect(sentOffs(scenario.command)).toBe(2));
      // The resend of the off is the only thing recovery sends. It never turns anything on.
      expect(scenario.command.mock.calls.filter(([enabled]) => enabled)).toHaveLength(1);
      if (source !== "screen") expect(uiState(scenario, source)).toBe("disabled");
      // Sync applies the resent off. A new on is sent at once but the UI waits for Sync's projection.
      project(scenario.platform, source, false);
      const on = scenario.setEnabled(true);
      await vi.waitFor(() => expect(scenario.command.mock.calls.filter(([enabled]) => enabled)).toHaveLength(2));
      // Screen share shows its own capture, so only the device sources are gated on Sync here.
      if (source !== "screen") expect(uiState(scenario, source)).not.toBe("enabled");
      // The media plane re-enables the track when it publishes again.
      scenario.track.enabled = true;
      projectOn(scenario, source);
      await on;
      if (source !== "screen") await vi.waitFor(() => expect(uiState(scenario, source)).toBe("enabled"));
    } finally {
      scenario.client.dispose();
    }
  });

  it.each(sources)("does not show %s as on when Sync refuses the on", async (source) => {
    const scenario = createConvergenceScenario(source);
    try {
      await scenario.client.join({ microphone: false, camera: false });
      scenario.command.mockRejectedValueOnce(new Error("muted by the host"));
      await expect(scenario.setEnabled(true)).rejects.toBeDefined();
      if (source !== "screen") expect(uiState(scenario, source)).not.toBe("enabled");
    } finally {
      scenario.client.dispose();
    }
  });
});

describe("an off that never reached Sync survives a replaced Sync connection", () => {
  it.each((["microphone", "camera"] as const).flatMap((source) => [false, true].map((failedAttempt) => ({ source, failedAttempt }))))("resends a lost $source off to the replacement Sync (a failed recovery attempt first: $failedAttempt)", async ({ source, failedAttempt }) => {
    const first = createCoreTestPlatform();
    const next = createCoreTestPlatform();
    const track = Object.assign(mediaTrack(), { kind: source === "microphone" ? "audio" : "video" });
    const command = vi.fn(async (_enabled: boolean) => receipt);
    let creations = 0;
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
      {
        ...first,
        dependencies: {
          ...first.dependencies,
          mediaDevices: { getUserMedia: async () => mediaStream(track) },
          createSyncClient: () => {
            const attempt = creations++;
            if (attempt === 0) return { ...first.sync, setMicrophoneEnabled: command, setCameraEnabled: command };
            // A failed attempt unbinds the ports before the next one binds, which is when the old result used to be wiped.
            if (failedAttempt && attempt === 1) return { ...next.sync, start: async () => Promise.reject(new Error("recovery attempt failed")) };
            return { ...next.sync, setMicrophoneEnabled: command, setCameraEnabled: command };
          },
        },
      },
    );
    const set = source === "microphone" ? client.media.setMicrophoneEnabled : client.media.setCameraEnabled;
    try {
      await client.join({ microphone: false, camera: false });
      await set(true);
      project(first, source, true, track);
      project(next, source, true, track);
      command.mockRejectedValueOnce(lost());
      await expect(set(false)).rejects.toBeDefined();
      expect(command.mock.calls.filter(([enabled]) => !enabled)).toHaveLength(1);
      first.emitSync({ ...first.sync.getSnapshot(), connection: { phase: "terminal", terminalReason: "fixture_disconnect" } });
      await vi.waitFor(() => expect(creations).toBe(failedAttempt ? 3 : 2), { timeout: 10000 });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"), { timeout: 10000 });
      await vi.waitFor(() => expect(command.mock.calls.filter(([enabled]) => !enabled)).toHaveLength(2), { timeout: 3000 });
      expect(command.mock.calls.filter(([enabled]) => enabled)).toHaveLength(1);
    } finally {
      client.dispose();
    }
  });
});

// The device owes Sync every off it was told to send until Sync shows the source off. The traces below come from review of the first version of this fix.
describe("an off stays owed until Sync shows the source off", () => {
  const offs = (command: ReturnType<typeof createConvergenceScenario>["command"]) => command.mock.calls.filter(([enabled]) => !enabled).length;
  const ons = (command: ReturnType<typeof createConvergenceScenario>["command"]) => command.mock.calls.filter(([enabled]) => enabled).length;
  const projectOnWith = (scenario: ReturnType<typeof createConvergenceScenario>, source: Source, publicationId: string) =>
    scenario.platform.emitSync({ ...scenario.platform.sync.getSnapshot(), media: { projectionId: "media", sequence: (scenario.platform.sync.getSnapshot().media?.sequence ?? 0) + 1, items: [{ participantId: "participant-1", source, enabled: true, publicationId }] } });

  it.each(["microphone", "camera"] as const)("keeps a %s off when a quick on is attempted during a reconnect", async (source) => {
    const scenario = createConvergenceScenario(source);
    try {
      await scenario.client.join({ microphone: false, camera: false });
      await scenario.setEnabled(true);
      projectOn(scenario, source);
      await enterRecovery(scenario);
      await scenario.setEnabled(false);
      // An on needs a live call, so it is refused and cannot cancel the owed off.
      await expect(scenario.setEnabled(true)).rejects.toBeDefined();
      scenario.platform.emitSync({ ...scenario.platform.sync.getSnapshot(), connection: { phase: "live" } });
      await vi.waitFor(() => expect(scenario.client.getSnapshot().connection.status).toBe("live"));
      await vi.waitFor(() => expect(offs(scenario.command)).toBe(1));
      await drain();
      expect(ons(scenario.command)).toBe(1);
      expect(scenario.track.enabled).toBe(false);
      expect(uiState(scenario, source)).toBe("disabled");
    } finally {
      scenario.client.dispose();
    }
  });

  it.each(["microphone", "camera"] as const)("resends a %s off that was in flight when Sync dropped and the first replacement failed", async (source) => {
    const first = createCoreTestPlatform();
    const next = createCoreTestPlatform();
    const track = Object.assign(mediaTrack(), { kind: source === "microphone" ? "audio" : "video" });
    const command = vi.fn(async (_enabled: boolean) => receipt);
    let creations = 0;
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
      {
        ...first,
        dependencies: {
          ...first.dependencies,
          mediaDevices: { getUserMedia: async () => mediaStream(track) },
          createSyncClient: () => {
            const attempt = creations++;
            if (attempt === 0) return { ...first.sync, setMicrophoneEnabled: command, setCameraEnabled: command };
            if (attempt === 1) return { ...next.sync, start: async () => Promise.reject(new Error("first recovery failed")) };
            return { ...next.sync, setMicrophoneEnabled: command, setCameraEnabled: command };
          },
        },
      },
    );
    const set = source === "microphone" ? client.media.setMicrophoneEnabled : client.media.setCameraEnabled;
    try {
      await client.join({ microphone: false, camera: false });
      await set(true);
      project(first, source, true, track);
      project(next, source, true, track);
      let rejectOff: (error: Error) => void = () => undefined;
      command.mockImplementationOnce(() => new Promise((_resolve, reject) => (rejectOff = reject)));
      const off = set(false).catch(() => undefined);
      await vi.waitFor(() => expect(command.mock.calls.filter(([enabled]) => !enabled)).toHaveLength(1));
      first.emitSync({ ...first.sync.getSnapshot(), connection: { phase: "terminal", terminalReason: "fixture_disconnect" } });
      rejectOff(new Error("off interrupted by the disconnect"));
      await off;
      await vi.waitFor(() => expect(creations).toBe(3), { timeout: 10000 });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"), { timeout: 10000 });
      await vi.waitFor(() => expect(command.mock.calls.filter(([enabled]) => !enabled).length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    } finally {
      client.dispose();
    }
  });

  it.each(sources)("resends an accepted %s off when the snapshot after a reconnect still shows its publication on", async (source) => {
    const scenario = createConvergenceScenario(source);
    try {
      await scenario.client.join({ microphone: false, camera: false });
      await scenario.setEnabled(true);
      projectOn(scenario, source);
      scenario.command.mockResolvedValue(receipt);
      await scenario.setEnabled(false);
      expect(offs(scenario.command)).toBe(1);
      await enterRecovery(scenario);
      // Sync restarted without the off and still shows the publication the device paused.
      projectOnWith(scenario, source, "publication-1");
      scenario.platform.emitSync({ ...scenario.platform.sync.getSnapshot(), connection: { phase: "live" } });
      await vi.waitFor(() => expect(offs(scenario.command)).toBe(2));
    } finally {
      scenario.client.dispose();
    }
  });

  it("does not turn off a publication from another device of the same participant", async () => {
    const scenario = await liveThenLostOff("microphone");
    try {
      projectOnWith(scenario, "microphone", "publication-of-another-device");
      await drain();
      expect(offs(scenario.command)).toBe(1);
    } finally {
      scenario.client.dispose();
    }
  });

  it("does not resend once the Sync projection already shows the source off", async () => {
    const scenario = await liveThenLostOff("microphone");
    try {
      project(scenario.platform, "microphone", false);
      await drain();
      expect(offs(scenario.command)).toBe(1);
    } finally {
      scenario.client.dispose();
    }
  });

  it("sends one retry, not one per snapshot, while an off retry is in flight", async () => {
    const scenario = createConvergenceScenario("microphone");
    try {
      await scenario.client.join({ microphone: false, camera: false });
      await scenario.setEnabled(true);
      projectOn(scenario, "microphone");
      scenario.command.mockRejectedValue(lost());
      await scenario.setEnabled(false).catch(() => undefined);
      for (let snapshot = 0; snapshot < 500; snapshot++) projectOn(scenario, "microphone");
      await drain();
      expect(offs(scenario.command)).toBe(2);
    } finally {
      scenario.client.dispose();
    }
  });

  describe("on a quiet healthy connection", () => {
    /** Under fake timers every await needs the clock to move, so each step runs the promise while the clock ticks. */
    const step = async <T>(promise: Promise<T>, tickMs = 20): Promise<T> => {
      const result = promise.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(tickMs);
      const settled = await result;
      if ("error" in settled) throw settled.error;
      return settled.value;
    };
    const offTimes: number[] = [];
    const liveThenLostOffUnderFakeTimers = async (source: "microphone" | "camera") => {
      vi.useFakeTimers();
      offTimes.length = 0;
      const scenario = createConvergenceScenario(source);
      await step(scenario.client.join({ microphone: false, camera: false }));
      await step(scenario.setEnabled(true));
      projectOn(scenario, source);
      scenario.command.mockImplementation(async (enabled) => {
        if (!enabled) offTimes.push(Date.now());
        throw lost();
      });
      await step(scenario.setEnabled(false)).catch(() => undefined);
      return scenario;
    };
    it.each(["microphone", "camera"] as const)("repairs a lost %s off on a timer with doubling backoff and stops once Sync shows it off", async (source) => {
      const scenario = await liveThenLostOffUnderFakeTimers(source);
      try {
        expect(offs(scenario.command)).toBe(1);
        // No Sync snapshot arrives in this time. Retries wait 1 s, 2 s, 4 s, 8 s, 16 s, then 30 s at most.
        await vi.advanceTimersByTimeAsync(200000);
        const gaps = offTimes.slice(1).map((time, index) => time - offTimes[index]!);
        // Each attempt adds a few milliseconds of its own, so the gaps are compared in 10 ms steps.
        expect(gaps.slice(0, 7).map((gap) => Math.floor(gap / 10) * 10)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
        const sent = offs(scenario.command);
        project(scenario.platform, source, false);
        await vi.advanceTimersByTimeAsync(120000);
        expect(offs(scenario.command)).toBe(sent);
      } finally {
        scenario.client.dispose();
        vi.useRealTimers();
      }
    });

    it("stops retrying when the client is disposed", async () => {
      const scenario = await liveThenLostOffUnderFakeTimers("microphone");
      try {
        scenario.client.dispose();
        await vi.advanceTimersByTimeAsync(120000);
        expect(offs(scenario.command)).toBe(1);
      } finally {
        scenario.client.dispose();
        vi.useRealTimers();
      }
    });

    it("stops retrying an off that a newer on replaced", async () => {
      const scenario = await liveThenLostOffUnderFakeTimers("microphone");
      try {
        scenario.command.mockReset();
        scenario.command.mockResolvedValue(receipt);
        const on = step(scenario.setEnabled(true));
        scenario.track.enabled = true;
        projectOn(scenario, "microphone");
        await on;
        await vi.advanceTimersByTimeAsync(120000);
        expect(offs(scenario.command)).toBe(0);
      } finally {
        scenario.client.dispose();
        vi.useRealTimers();
      }
    });
  });
});
