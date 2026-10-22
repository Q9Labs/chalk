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

function endingTrack(source: "microphone" | "camera", id: string) {
  let ended = false;
  const track = Object.assign(mediaTrack(), {
    kind: source === "microphone" ? "audio" : "video",
    id,
    stop: vi.fn(() => {
      ended = true;
    }),
  });
  Object.defineProperty(track, "readyState", { get: () => (ended ? "ended" : "live") });
  return {
    track,
    end: () => {
      ended = true;
      track.dispatchEvent(new Event("ended"));
    },
  };
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

  it.each(["microphone", "camera"] as const)("captures and prepares a fresh %s after the published track ends", async (source) => {
    const platform = createCoreTestPlatform();
    const original = endingTrack(source, "original");
    const replacement = endingTrack(source, "replacement");
    let releaseReceipt = () => {};
    const receiptHeld = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    const capture = vi.fn().mockResolvedValueOnce(mediaStream(original.track)).mockResolvedValue(mediaStream(replacement.track));
    const send = vi.fn(async (enabled: boolean) => {
      if (enabled && send.mock.calls.length === 1) await receiptHeld;
      return { operationId: "device-loss", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" } as const;
    });
    const prepared = new Map<string, MediaStreamTrack>();
    const prepareLocalTrack = vi.fn((preparedSource: string, track: MediaStreamTrack) => {
      if (prepared.has(preparedSource)) throw new Error(`A ${preparedSource} track is already prepared`);
      prepared.set(preparedSource, track);
    });
    const clearPreparedLocalTrack = vi.fn(async (preparedSource: string) => {
      prepared.delete(preparedSource);
    });
    const client = capturedClient(platform, original.track, { mediaDevices: { getUserMedia: capture }, media: { prepareLocalTrack, clearPreparedLocalTrack }, sync: { setMicrophoneEnabled: send, setCameraEnabled: send } });
    const setEnabled = source === "microphone" ? client.media.setMicrophoneEnabled : client.media.setCameraEnabled;
    try {
      await client.join({ microphone: false, camera: false });
      const on = setEnabled(true).catch((error: unknown) => error);
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(true));
      original.end();
      const off = setEnabled(false).catch((error: unknown) => error);
      releaseReceipt();
      await Promise.all([on, off]);
      await setEnabled(true);
      expect(capture).toHaveBeenCalledTimes(2);
      expect(prepared.get(source)).toBe(replacement.track);
      expect(prepareLocalTrack).toHaveBeenLastCalledWith(source, replacement.track);
      expect(client.getSnapshot().media.local[source].track).toBe(replacement.track);
      expect(send.mock.calls.map(([enabled]) => enabled)).toEqual([true, false, true]);
    } finally {
      releaseReceipt();
      client.dispose();
    }
  });

  it("does not capture a microphone after Off arrives while the ended track is retired", async () => {
    const platform = createCoreTestPlatform();
    const original = endingTrack("microphone", "original");
    let releaseClear = () => {};
    const clearHeld = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const capture = vi
      .fn()
      .mockResolvedValueOnce(mediaStream(original.track))
      .mockResolvedValue(mediaStream(endingTrack("microphone", "late").track));
    const send = vi.fn(async () => ({ operationId: "retire-race", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" }) as const);
    const clearPreparedLocalTrack = vi.fn(async () => {
      await clearHeld;
    });
    const client = capturedClient(platform, original.track, { mediaDevices: { getUserMedia: capture }, media: { clearPreparedLocalTrack }, sync: { setMicrophoneEnabled: send } });
    try {
      await client.join({ microphone: false, camera: false });
      await client.media.setMicrophoneEnabled(true);
      original.end();
      const on = client.media.setMicrophoneEnabled(true).catch((error: unknown) => error);
      await vi.waitFor(() => expect(clearPreparedLocalTrack).toHaveBeenCalledWith("microphone", { stopTrack: false }));
      const off = client.media.setMicrophoneEnabled(false);
      releaseClear();
      await Promise.all([on, off]);
      expect(capture).toHaveBeenCalledOnce();
      expect(send.mock.calls.at(-1)).toEqual([false]);
    } finally {
      releaseClear();
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
