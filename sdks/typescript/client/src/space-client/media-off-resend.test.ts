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
