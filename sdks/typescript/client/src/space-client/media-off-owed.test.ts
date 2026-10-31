import { describe, expect, it, vi } from "vitest";
import { createConvergenceScenario, enterRecovery } from "../../tests/helpers/media-convergence";

const sources = ["microphone", "camera", "screen"] as const;
type Scenario = ReturnType<typeof createConvergenceScenario>;
type Source = (typeof sources)[number];
function project(s: Scenario, source: Source, publicationId: string) {
  s.platform.emitSync({ ...s.platform.sync.getSnapshot(), media: { projectionId: "media", sequence: (s.platform.sync.getSnapshot().media?.sequence ?? 0) + 1, items: [{ participantId: "participant-1", source, enabled: true, publicationId }] } });
}
async function lostOff(source: Source) {
  const s = createConvergenceScenario(source);
  await s.client.join({ microphone: false, camera: false });
  await s.setEnabled(true);
  s.platform.media.emit({ ...s.platform.media.getSnapshot(), localTracks: [{ participantId: "participant-1", source, enabled: true, publicationId: "own-publication", track: s.track }] });
  project(s, source, "own-publication");
  s.command.mockRejectedValueOnce(new Error("lost off"));
  await expect(s.setEnabled(false)).rejects.toBeDefined();
  expect(s.command.mock.calls.filter(([enabled]) => !enabled)).toHaveLength(1);
  return s;
}
describe("owed off: ownership at reconnect", () => {
  it.each(sources)("does not resend an owed %s off against a different device's publication after reconnect", async (source) => {
    const s = await lostOff(source);
    try {
      await enterRecovery(s);
      // The old device is paused. A second device using this participant now owns the source.
      project(s, source, "other-device-publication");
      s.platform.emitSync({ ...s.platform.sync.getSnapshot(), connection: { phase: "live" } });
      await vi.waitFor(() => expect(s.client.getSnapshot().connection.status).toBe("live"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(s.command.mock.calls.filter(([enabled]) => !enabled)).toHaveLength(1);
    } finally {
      s.client.dispose();
    }
  });
});

describe("owed off: retry lifecycle", () => {
  const receipt = { operationId: "off", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" } as const;
  it.each(sources)("a newer %s on supersedes an already in-flight retry without a later off", async (source) => {
    const s = await lostOff(source);
    let resolveRetry: () => void = () => {
      throw new Error("retry has not started");
    };
    try {
      s.command.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRetry = () => resolve(receipt);
          }),
      );
      await vi.waitFor(() => expect(s.command.mock.calls.filter(([enabled]) => !enabled)).toHaveLength(2), { timeout: 1800 });
      const on = s.setEnabled(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      resolveRetry();
      s.track.enabled = true;
      project(s, source, "own-publication");
      await on;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(s.command.mock.calls.map(([enabled]) => enabled)).toEqual([true, false, false, true]);
    } finally {
      s.client.dispose();
    }
  });
  it("disposing during an in-flight retry does not create another send when it rejects", async () => {
    const s = await lostOff("microphone");
    let rejectRetry: () => void = () => {
      throw new Error("retry has not started");
    };
    try {
      s.command.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectRetry = () => reject(new Error("late failure"));
          }),
      );
      await vi.waitFor(() => expect(s.command.mock.calls.filter(([enabled]) => !enabled)).toHaveLength(2), { timeout: 1800 });
      s.client.dispose();
      rejectRetry();
      await new Promise((resolve) => setTimeout(resolve, 2200));
      expect(s.command.mock.calls.filter(([enabled]) => !enabled)).toHaveLength(2);
    } finally {
      s.client.dispose();
    }
  });
});

describe("owed off: no local publication ID yet", () => {
  it.each(sources)("still resends a lost %s off after reconnect when Sync knows the publication but the device has not observed its ID", async (source) => {
    const s = createConvergenceScenario(source);
    try {
      await s.client.join({ microphone: false, camera: false });
      await s.setEnabled(true);
      // Publication discovery on the media plane lags the Sync projection.
      expect(s.platform.media.getSnapshot().localTracks).toHaveLength(0);
      project(s, source, "not-yet-observed-locally");
      s.command.mockRejectedValueOnce(new Error("lost off"));
      await expect(s.setEnabled(false)).rejects.toBeDefined();
      await enterRecovery(s);
      s.platform.emitSync({ ...s.platform.sync.getSnapshot(), connection: { phase: "live" } });
      await vi.waitFor(() => expect(s.command.mock.calls.filter(([enabled]) => !enabled)).toHaveLength(2));
      if (source !== "screen") expect(s.track.enabled).toBe(false);
    } finally {
      s.client.dispose();
    }
  });
});

describe("owed off: on during loss notification", () => {
  it.each(["microphone", "camera"] as const)("keeps the owed %s off if on races the first recovering snapshot", async (source) => {
    const s = await lostOff(source);
    try {
      s.platform.emitSync({ ...s.platform.sync.getSnapshot(), connection: { phase: "recovering" } });
      const statusAtOn = s.client.getSnapshot().connection.status;
      const onError: unknown = await s.setEnabled(true).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(onError).toBeDefined();
      await vi.waitFor(() => expect(s.client.getSnapshot().connection.status).toBe("reconnecting"));
      s.platform.emitSync({ ...s.platform.sync.getSnapshot(), connection: { phase: "live" } });
      await vi.waitFor(() => expect(s.client.getSnapshot().connection.status).toBe("live"));
      await new Promise((resolve) => setTimeout(resolve, 3500));
      console.log("judge-loss-notification-trace", {
        source,
        statusAtOn,
        onError,
        commands: s.command.mock.calls.map(([enabled]) => enabled),
        recoveredStatus: s.client.getSnapshot().connection.status,
        ui: s.client.getSnapshot().media.local[source].state,
        trackEnabled: s.track.enabled,
        sync: s.platform.sync.getSnapshot().media?.items,
      });
      expect(s.command.mock.calls.filter(([enabled]) => !enabled)).toHaveLength(2);
      expect(s.track.enabled).toBe(false);
    } finally {
      s.client.dispose();
    }
  });
});

// Every short sequence of {user off with the first send lost, Sync recovering, user on while recovering, another device's
// publication} followed by a reconnect must keep the two rules of the owed off (see media-controller.ts).
describe("owed off invariants over every short event sequence", () => {
  const events = ["off", "recover", "onWhileRecovering", "otherDevice"] as const;
  type Event = (typeof events)[number];
  const sequences: Event[][] = [[]];
  for (let length = 1; length <= 3; length++) for (const prefix of sequences.filter((sequence) => sequence.length === length - 1)) for (const event of events) sequences.push([...prefix, event]);
  const offsSent = (s: Scenario) => s.command.mock.calls.filter(([enabled]) => !enabled).length;

  async function run(sequence: readonly Event[]): Promise<string | null> {
    const s = createConvergenceScenario("microphone");
    try {
      await s.client.join({ microphone: false, camera: false });
      await s.setEnabled(true);
      s.platform.media.emit({ ...s.platform.media.getSnapshot(), localTracks: [{ participantId: "participant-1", source: "microphone", enabled: true, publicationId: "own-publication", track: s.track }] });
      project(s, "microphone", "own-publication");
      let firstOff = true;
      s.command.mockImplementation(async (enabled) => {
        if (!enabled && firstOff) {
          firstOff = false;
          throw new Error("lost off");
        }
        return { operationId: "off", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" } as const;
      });
      let recovering = false;
      for (const event of sequence) {
        if (event === "off") await s.setEnabled(false).catch(() => undefined);
        if (event === "otherDevice") project(s, "microphone", "other-device-publication");
        if (event === "recover" && !recovering) await enterRecovery(s);
        if (event === "onWhileRecovering" && recovering) await s.setEnabled(true).catch(() => undefined);
        if (event === "recover") recovering = true;
      }
      if (!recovering) await enterRecovery(s);
      const before = offsSent(s);
      s.platform.emitSync({ ...s.platform.sync.getSnapshot(), connection: { phase: "live" } });
      await vi.waitFor(() => expect(s.client.getSnapshot().connection.status).toBe("live"));
      await new Promise((resolve) => setTimeout(resolve, 40));
      const after = offsSent(s) - before;
      const expected = sequence.includes("off") && !sequence.includes("otherDevice") ? 1 : 0;
      return after === expected ? null : `${sequence.join(",") || "(none)"}: ${after} offs after the reconnect, expected ${expected}`;
    } finally {
      s.client.dispose();
    }
  }

  it("resends the owed off exactly once, and never against another device's publication", async () => {
    const failures: string[] = [];
    for (const sequence of sequences) {
      const failure = await run(sequence);
      if (failure) failures.push(failure);
    }
    expect(failures).toEqual([]);
  }, 120000);
});
