import { describe, expect, it, vi } from "vitest";
import { createConvergenceScenario } from "../../tests/helpers/media-convergence";

type Platform = ReturnType<typeof createConvergenceScenario>["platform"];
const swap = (platform: Platform) => platform.media.emit({ ...platform.media.getSnapshot(), connection: { phase: "recovering", peerConnectionState: "connecting", iceConnectionState: "checking" }, failure: null });
const finish = (platform: Platform) => platform.media.emit({ ...platform.media.getSnapshot(), connection: { phase: "live", peerConnectionState: "connected", iceConnectionState: "connected" }, failure: null });
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("media intents during a media connection swap", () => {
  // Known gap: once the swap outlasts the 250 ms lifecycle grace, #pauseRecoveredIntents treats the still-unsent
  // click as lost to Sync and cancels it. The recovery-rule fix (pause only when Sync's own state says off) is
  // owned by a separate PR; drop `.fails` when it lands.
  it.fails.each(["microphone", "camera"] as const)("preserves an early %s click across the lifecycle grace boundary", async (source) => {
    const sourceIntent = vi.fn(async () => {});
    const { client, platform, command, capture, setEnabled } = createConvergenceScenario(source, { media: { setLocalSourceIntent: sourceIntent } });
    try {
      await client.join({ microphone: false, camera: false });
      swap(platform);
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
      const result = setEnabled(true).then(
        () => "enabled",
        (cause: unknown) => cause,
      );
      await tick(400);
      expect(command).not.toHaveBeenCalled();
      finish(platform);
      const outcome = await result;
      expect(sourceIntent).not.toHaveBeenCalledWith(source, false, "sync_recovery_loss");
      expect(outcome).toBe("enabled");
      expect(command).toHaveBeenCalledExactlyOnceWith(true);
      expect(capture).toHaveBeenCalledOnce();
    } finally {
      client.dispose();
    }
  });

  it.each(["microphone", "camera"] as const)("a newer %s mute cancels the queued enable", async (source) => {
    const { client, platform, command, capture, setEnabled } = createConvergenceScenario(source);
    try {
      await client.join({ microphone: false, camera: false });
      swap(platform);
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
      const on = setEnabled(true);
      await tick();
      await setEnabled(false);
      await on;
      finish(platform);
      await tick(20);
      expect(command).not.toHaveBeenCalledWith(true);
      expect(capture).not.toHaveBeenCalled();
      expect(client.getSnapshot().media.local[source].state).not.toBe("requesting");
    } finally {
      client.dispose();
    }
  });

  it.each(["microphone", "camera"] as const)("keeps the latest %s enable after rapid mute then unmute", async (source) => {
    const { client, platform, command, setEnabled } = createConvergenceScenario(source);
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      command.mockClear();
      swap(platform);
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
      const off = setEnabled(false);
      const on = setEnabled(true);
      await tick();
      finish(platform);
      await Promise.all([off, on]);
      expect(command.mock.calls.at(-1)).toEqual([true]);
      expect(command.mock.calls.filter(([enabled]) => enabled)).toHaveLength(1);
    } finally {
      client.dispose();
    }
  });

  it.each(["timeout", "sync-loss", "dispose"] as const)("settles without replay after %s during a swap", async (ending) => {
    const { client, platform, command, capture, setEnabled } = createConvergenceScenario("microphone");
    let expire: (() => void) | undefined;
    const schedule = platform.dependencies.clock.setTimeout;
    const timer = vi.spyOn(platform.dependencies.clock, "setTimeout").mockImplementation((callback, milliseconds) => {
      if (milliseconds === 10000) {
        expire = callback;
        return null;
      }
      return schedule(callback, milliseconds);
    });
    try {
      await client.join({ microphone: false, camera: false });
      swap(platform);
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
      const result = setEnabled(true).then(
        () => "enabled",
        (cause: unknown) => cause,
      );
      await vi.waitFor(() => expect(expire).toBeTypeOf("function"));
      if (ending === "timeout") expire!();
      if (ending === "sync-loss") {
        platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "recovering" } });
        await tick();
        finish(platform);
        platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
      }
      if (ending === "dispose") client.dispose();
      const outcome = await result;
      expect(outcome).not.toBe("enabled");
      if (ending === "timeout") expect(outcome).toMatchObject({ code: "media.timeout" });
      finish(platform);
      await tick(20);
      expect(command).not.toHaveBeenCalledWith(true);
      expect(capture).not.toHaveBeenCalled();
    } finally {
      client.dispose();
      timer.mockRestore();
    }
  });
});
