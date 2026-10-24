import { describe, expect, it, vi } from "vitest";
import { createConvergenceScenario, mediaStream } from "../../tests/helpers/media-convergence";

describe("media readiness", () => {
  it.each(["camera", "microphone"] as const)("waits if recovery starts during the first %s capture", async (source) => {
    const { client, platform, capture, command, setEnabled, track } = createConvergenceScenario(source);
    let finishCapture = () => {};
    const capturing = new Promise<void>((resolve) => {
      finishCapture = resolve;
    });
    capture.mockImplementationOnce(async () => {
      await capturing;
      return mediaStream(track);
    });
    try {
      await client.join({ microphone: false, camera: false });
      const result = setEnabled(true).then(
        () => "enabled",
        (cause: unknown) => cause,
      );
      await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "recovering" } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
      finishCapture();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(command).not.toHaveBeenCalled();
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
      expect(await result).toBe("enabled");
      expect(command).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      finishCapture();
      client.dispose();
    }
  });
  it.each(["camera", "microphone"] as const)("keeps the first %s toggle pending until joining finishes", async (source) => {
    let finishStart = () => {};
    const starting = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    const fixture = createConvergenceScenario(source, {
      sync: {
        start: async () => {
          await starting;
          await fixture.platform.sync.start();
        },
      },
    });
    const { client, setEnabled, capture, command } = fixture;
    try {
      const joining = client.join({ microphone: false, camera: false }).then(
        () => "joined",
        (cause: unknown) => cause,
      );
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("joining"));
      const result = setEnabled(true).then(
        () => "enabled",
        (cause: unknown) => cause,
      );
      await vi.waitFor(() => expect(client.getSnapshot().media.local[source].state).toBe("requesting"));
      expect(capture).not.toHaveBeenCalled();
      expect(command).not.toHaveBeenCalled();
      finishStart();
      expect(await joining).toBe("joined");
      expect(await result).toBe("enabled");
      expect(capture).toHaveBeenCalledOnce();
      expect(command).toHaveBeenCalledExactlyOnceWith(true);
      await setEnabled(false);
      await setEnabled(true);
      expect(command.mock.calls.map(([enabled]) => enabled)).toEqual([true, false, true]);
    } finally {
      finishStart();
      client.dispose();
    }
  });

  it.each(["camera", "microphone"] as const)("finishes a successful first %s toggle after media recovery", async (source) => {
    let finishCommand = () => {};
    const publishing = new Promise<void>((resolve) => {
      finishCommand = resolve;
    });
    const { client, platform, command, setEnabled } = createConvergenceScenario(source);
    command.mockImplementationOnce(async () => {
      await publishing;
      return { operationId: "first-enable", name: "set_microphone_enabled", serverOutcome: "confirmed", mediaPlaneOutcome: "confirmed" };
    });
    try {
      await client.join({ microphone: false, camera: false });
      const result = setEnabled(true).then(
        () => "enabled",
        (cause: unknown) => cause,
      );
      await vi.waitFor(() => expect(command).toHaveBeenCalledOnce());
      platform.media.emit({ ...platform.media.getSnapshot(), connection: { phase: "failed", peerConnectionState: "failed", iceConnectionState: "failed" }, failure: { code: "signaling_failed", recoverable: true } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
      finishCommand();
      await new Promise((resolve) => setTimeout(resolve, 0));
      platform.media.emit({ ...platform.media.getSnapshot(), connection: { phase: "live", peerConnectionState: "connected", iceConnectionState: "connected" }, failure: null });
      expect(await result).toBe("enabled");
      expect(command).toHaveBeenCalledOnce();
    } finally {
      finishCommand();
      client.dispose();
    }
  });

  it.each(["camera", "microphone"] as const)("does not enable %s after Off cancels a pending toggle", async (source) => {
    const { client, platform, capture, command, setEnabled } = createConvergenceScenario(source);
    try {
      await client.join({ microphone: false, camera: false });
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "recovering" } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
      const enabling = setEnabled(true);
      await vi.waitFor(() => expect(client.getSnapshot().media.local[source].state).toBe("requesting"));
      await setEnabled(false);
      await enabling;
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      expect(capture).not.toHaveBeenCalled();
      expect(command.mock.calls.every(([enabled]) => !enabled)).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it.each(["camera", "microphone"] as const)("reports a bounded wait for %s and never enables it later", async (source) => {
    const { client, platform, capture, command, setEnabled } = createConvergenceScenario(source);
    let expire = () => {};
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
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "recovering" } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
      const result = setEnabled(true).then(
        () => "enabled",
        (cause: unknown) => cause,
      );
      await vi.waitFor(() => expect(client.getSnapshot().media.local[source].state).toBe("requesting"));
      expire();
      expect(await result).toMatchObject({ code: "media.timeout", recoverable: true });
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      expect(capture).not.toHaveBeenCalled();
      expect(command).not.toHaveBeenCalled();
      expect(client.getSnapshot().media.local[source].state).not.toBe("requesting");
    } finally {
      client.dispose();
      timer.mockRestore();
    }
  });
});
