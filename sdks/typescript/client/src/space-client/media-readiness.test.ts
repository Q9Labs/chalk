import { describe, expect, it, vi } from "vitest";
import { createConvergenceScenario, mediaStream } from "../../tests/helpers/media-convergence";
import { mediaTrack } from "../../tests/helpers/media-convergence";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

describe("media readiness", () => {
  it.each(["camera", "microphone"] as const)("does not block initial startup when %s is enabled while access is loading", async (source) => {
    const platform = createCoreTestPlatform();
    const track = Object.assign(mediaTrack(), { kind: source === "camera" ? "video" : "audio" });
    let finishAccess = () => {};
    const access = new Promise<void>((resolve) => {
      finishAccess = resolve;
    });
    const command = vi.fn(async () => ({ operationId: "early", name: "set_microphone_enabled" as const, serverOutcome: "confirmed" as const, mediaPlaneOutcome: "confirmed" as const }));
    const client = createSpaceClientForPlatform(
      {
        space: "early",
        getAccess: async () => {
          await access;
          return opaqueAccessGrant("early");
        },
      },
      {
        ...platform,
        dependencies: {
          ...platform.dependencies,
          mediaDevices: { getUserMedia: async () => mediaStream(track), getDisplayMedia: async () => mediaStream(track), enumerateDevices: async () => [] },
          createSyncClient: () => ({ ...platform.sync, setCameraEnabled: command, setMicrophoneEnabled: command }),
        },
      },
    );
    try {
      const joining = client.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("joining"));
      const enabled = (source === "camera" ? client.media.setCameraEnabled(true) : client.media.setMicrophoneEnabled(true)).catch((cause: unknown) => cause);
      await vi.waitFor(() => expect(client.getSnapshot().media.local[source].state).toBe("requesting"));
      finishAccess();
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      expect(await joining).toBeUndefined();
      expect(await enabled).toBeUndefined();
      expect(command).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      finishAccess();
      client.dispose();
    }
  });

  it("clears readiness timers after a successful toggle", async () => {
    const { client, platform, setEnabled } = createConvergenceScenario("camera");
    try {
      await client.join({ microphone: false, camera: false });
      const scheduled = vi.spyOn(platform.dependencies.clock, "setTimeout");
      const cleared = vi.spyOn(platform.dependencies.clock, "clearTimeout");
      await setEnabled(true);
      const readinessTimers = scheduled.mock.calls.flatMap(([, milliseconds], index) => (milliseconds === 10000 ? [scheduled.mock.results[index]?.value] : []));
      expect(readinessTimers.length).toBeGreaterThan(0);
      for (const timer of readinessTimers) expect(cleared).toHaveBeenCalledWith(timer);
    } finally {
      client.dispose();
      vi.restoreAllMocks();
    }
  });

  it("rolls back screen capture when its successful command is interrupted by recovery", async () => {
    const { client, platform, command, setEnabled, track } = createConvergenceScenario("screen");
    let finishCommand = () => {};
    const pending = new Promise<void>((resolve) => {
      finishCommand = resolve;
    });
    command.mockImplementationOnce(async () => {
      await pending;
      return { operationId: "screen", name: "set_screen_share_enabled", serverOutcome: "confirmed", mediaPlaneOutcome: "confirmed" };
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
      expect(await result).toMatchObject({ code: "connection.invalid_state" });
      expect(track.stop).toHaveBeenCalled();
    } finally {
      finishCommand();
      client.dispose();
    }
  });
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
    const { client, capture, command, setEnabled } = fixture;
    try {
      const joining = client.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("joining"));
      const enabling = setEnabled(true);
      await vi.waitFor(() => expect(client.getSnapshot().media.local[source].state).toBe("requesting"));
      await setEnabled(false);
      await enabling;
      finishStart();
      expect(await joining).toBeUndefined();
      expect(capture).not.toHaveBeenCalled();
      expect(command.mock.calls.every(([enabled]) => !enabled)).toBe(true);
    } finally {
      finishStart();
      client.dispose();
    }
  });

  it.each(["camera", "microphone"] as const)("reports a bounded wait for %s and never enables it later", async (source) => {
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
    const { client, platform, capture, command, setEnabled } = fixture;
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
      const joining = client.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("joining"));
      const result = setEnabled(true).then(
        () => "enabled",
        (cause: unknown) => cause,
      );
      await vi.waitFor(() => expect(client.getSnapshot().media.local[source].state).toBe("requesting"));
      expire();
      expect(await result).toMatchObject({ code: "media.timeout", recoverable: true });
      finishStart();
      expect(await joining).toBeUndefined();
      expect(capture).not.toHaveBeenCalled();
      expect(command).not.toHaveBeenCalled();
      expect(client.getSnapshot().media.local[source].state).not.toBe("requesting");
    } finally {
      finishStart();
      client.dispose();
      timer.mockRestore();
    }
  });
});
