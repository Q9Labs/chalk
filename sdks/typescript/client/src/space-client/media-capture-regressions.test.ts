import { describe, expect, it, vi } from "vitest";
import { capturedClient, createConvergenceScenario, mediaStream, mediaTrack } from "../../tests/helpers/media-convergence";
import { V1SyncError } from "../sync/v1-error";
import { createCoreTestPlatform } from "./core.test.helpers";

function heldCapture() {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const platform = createCoreTestPlatform();
  const track = Object.assign(mediaTrack(), { stop: vi.fn() });
  const capture = vi.fn(async () => {
    await gate;
    return mediaStream(track);
  });
  return { platform, track, capture, release };
}

describe("media capture ownership", () => {
  it("stops microphone capture superseded by Off, before disposal", async () => {
    const { platform, track, capture, release } = heldCapture();
    const client = capturedClient(platform, track, { mediaDevices: { getUserMedia: capture }, sync: { setMicrophoneEnabled: async () => ({ operationId: "off", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" }) } });
    try {
      await client.join({ microphone: false, camera: false });
      const on = client.media.setMicrophoneEnabled(true).catch((error: unknown) => error);
      await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
      const off = client.media.setMicrophoneEnabled(false);
      release();
      await Promise.all([on, off]);
      expect(track.stop).toHaveBeenCalledOnce();
    } finally {
      release();
      client.dispose();
    }
  });

  it("prepares a microphone omitted from the initial publication on the next unmute", async () => {
    const { platform, track, capture, release } = heldCapture();
    const prepared = new Set<string>();
    const prepareLocalTrack = vi.fn((source: string) => {
      prepared.add(source);
    });
    const client = capturedClient(platform, track, {
      mediaDevices: { getUserMedia: capture },
      media: {
        prepareLocalTrack,
        start: async (stream) => {
          for (const item of stream.getTracks()) prepared.add(item.kind === "audio" ? "microphone" : "camera");
          platform.media.emit({ ...platform.media.getSnapshot(), connection: { ...platform.media.getSnapshot().connection, phase: "live" } });
        },
      },
      sync: {
        setMicrophoneEnabled: async (enabled) => {
          if (enabled && !prepared.has("microphone")) throw new V1SyncError("source unavailable", "source_unavailable");
          return { operationId: "capture", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" };
        },
      },
    });
    try {
      const join = client.join({ microphone: true, camera: false });
      await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
      const off = client.media.setMicrophoneEnabled(false);
      release();
      await Promise.all([join, off]);
      await expect(client.media.setMicrophoneEnabled(true)).resolves.toBeUndefined();
      expect(prepareLocalTrack).toHaveBeenCalledWith("microphone", track);
    } finally {
      release();
      client.dispose();
    }
  });

  it("a rejected duplicate join does not change active media", async () => {
    const { client, track, setEnabled } = createConvergenceScenario("microphone");
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      expect(track.enabled).toBe(true);
      await expect(client.join({ microphone: false, camera: false })).rejects.toBeDefined();
      expect(track.enabled).toBe(true);
    } finally {
      client.dispose();
    }
  });
});
