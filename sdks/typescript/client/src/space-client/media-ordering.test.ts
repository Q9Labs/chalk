import { capturedClient, createConvergenceScenario, enterRecovery, mediaStream, mediaTrack } from "../../tests/helpers/media-convergence";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionSyncClient } from "../connection/dependencies";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";
import { control } from "./terminal.test.helpers";

const sources = ["microphone", "camera", "screen"] as const;
const receipt = { operationId: "r7", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" } as const;
const drain = () => new Promise((resolve) => setTimeout(resolve, 30));
function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function project(platform: ReturnType<typeof createCoreTestPlatform>, source: (typeof sources)[number], enabled: boolean, publicationId: string | null) {
  platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "r7-media", sequence: (platform.sync.getSnapshot().media?.sequence ?? 0) + 1, items: [{ participantId: "participant-1", source, enabled, publicationId }] } });
}

describe("independent r7 ordering", () => {
  it.each(sources)("collapses %s off/on/off while first send is held", async (source) => {
    const { platform, command, client, setEnabled } = createConvergenceScenario(source);
    const ack = barrier();
    let server = false;
    command.mockImplementation(async (enabled) => {
      server = enabled;
      if (enabled) await ack.promise;
      return receipt;
    });
    try {
      await client.join({ microphone: false, camera: false });
      const first = setEnabled(true).catch((e) => e);
      await vi.waitFor(() => expect(command).toHaveBeenCalledWith(true));
      const off1 = setEnabled(false).catch((e) => e);
      const on = setEnabled(true).catch((e) => e);
      const off2 = setEnabled(false).catch((e) => e);
      await drain();
      ack.release();
      await Promise.all([first, off1, on, off2]);
      await drain();
      expect(server).toBe(false);
      expect(command.mock.calls.map(([v]) => v)).toEqual([true, false]);
    } finally {
      ack.release();
      client.dispose();
    }
  });

  it.each(sources.flatMap((source) => ["leave", "recover"].map((interruption) => ({ source, interruption }))))("does not revive $source capture after cancellation during $interruption; allows a fresh action", async ({ source, interruption }) => {
    const platform = createCoreTestPlatform();
    const track = Object.assign(mediaTrack(), { kind: source === "microphone" ? "audio" : "video", stop: vi.fn() });
    const gate = barrier();
    const capture = vi.fn(async () => {
      if (capture.mock.calls.length === 1) await gate.promise;
      return mediaStream(track);
    });
    const command = vi.fn<ConnectionSyncClient["setMicrophoneEnabled"]>(async () => receipt);
    const client = capturedClient(platform, track, { mediaDevices: { getUserMedia: capture, getDisplayMedia: capture }, sync: { setMicrophoneEnabled: command, setCameraEnabled: command, setScreenShareEnabled: command } });
    const setEnabled = source === "microphone" ? client.media.setMicrophoneEnabled : source === "camera" ? client.media.setCameraEnabled : client.media.setScreenShareEnabled;
    try {
      await client.join({ microphone: false, camera: false });
      const on = setEnabled(true).catch((e) => e);
      await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
      if (interruption === "leave") await client.leave();
      else await enterRecovery({ platform, client });
      const stopping = interruption === "recover" ? setEnabled(false) : Promise.resolve();
      gate.release();
      await Promise.all([on, stopping]);
      await drain();
      expect(command).not.toHaveBeenCalledWith(true);
      if (interruption === "leave") {
        expect(command).not.toHaveBeenCalled();
        expect(track.stop).toHaveBeenCalled();
      } else {
        platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
        await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
        await drain();
        expect(command).not.toHaveBeenCalledWith(true);
        command.mockClear();
        await setEnabled(true);
        expect(command).toHaveBeenCalledExactlyOnceWith(true);
      }
    } finally {
      gate.release();
      client.dispose();
    }
  });

  it.each(sources.flatMap((source) => [false, true].map((fresh) => ({ source, fresh }))))("ignores late $source off projections after a newer enable (fresh publication: $fresh)", async ({ source, fresh }) => {
    const { platform, track, command, client, setEnabled } = createConvergenceScenario(source);
    let server = false;
    command.mockImplementation(async (enabled) => {
      server = enabled;
      return receipt;
    });
    const emitLocal = (publicationId: string) => platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ source, enabled: true, publicationId, track }] });
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      if (!fresh) emitLocal("old-publication");
      project(platform, source, true, "old-publication");
      await setEnabled(false);
      await setEnabled(true);
      if (fresh) emitLocal("new-publication");
      project(platform, source, false, null);
      project(platform, source, true, fresh ? "new-publication" : "old-publication");
      command.mockClear();
      await enterRecovery({ platform, client });
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      await drain();
      expect(server, JSON.stringify(command.mock.calls)).toBe(true);
      expect(command).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it("does not let an old off projection satisfy a newer screen Stop", async () => {
    const platform = createCoreTestPlatform();
    const cleanup = barrier();
    let holdCleanup = false;
    let server = false;
    let generation = 0;
    let currentTrack = Object.assign(mediaTrack(), { kind: "video" });
    const capture = vi.fn(async () => {
      currentTrack = Object.assign(mediaTrack(), { kind: "video", id: `capture-${++generation}`, stop: vi.fn() });
      return mediaStream(currentTrack);
    });
    const clear = vi.fn(async () => {
      platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [] });
      if (holdCleanup) await cleanup.promise;
    });
    const command = vi.fn<ConnectionSyncClient["setScreenShareEnabled"]>(async (enabled) => {
      server = enabled;
      if (enabled) platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ source: "screen", enabled, publicationId: `publication-${generation}`, track: currentTrack }] });
      return receipt;
    });
    const client = capturedClient(platform, mediaTrack(), { mediaDevices: { getDisplayMedia: capture }, media: { clearPreparedLocalTrack: clear }, sync: { setScreenShareEnabled: command } });
    try {
      await client.join({ microphone: false, camera: false });
      await client.media.setScreenShareEnabled(true);
      project(platform, "screen", true, "publication-1");
      await client.media.setScreenShareEnabled(false);
      await client.media.setScreenShareEnabled(true);
      command.mockClear();
      clear.mockClear();
      holdCleanup = true;
      const latestStop = client.media.setScreenShareEnabled(false);
      await vi.waitFor(() => expect(clear).toHaveBeenCalled());
      // Delayed projection from the previous Stop; the server is already on again.
      project(platform, "screen", false, null);
      cleanup.release();
      await latestStop;
      // The later On projection is newer than that old Off, not newer user intent.
      project(platform, "screen", true, "publication-2");
      await drain();
      expect(server, JSON.stringify(command.mock.calls)).toBe(false);
      expect(command.mock.calls.map(([v]) => v)).toEqual([false]);
    } finally {
      cleanup.release();
      client.dispose();
    }
  });

  it.each(["microphone", "camera"] as const)("preserves a newer %s Off while join capture is pending", async (source) => {
    const platform = createCoreTestPlatform();
    const captureGate = barrier();
    const track = Object.assign(mediaTrack(), { kind: source === "microphone" ? "audio" : "video", stop: vi.fn() });
    const capture = vi.fn(async () => {
      await captureGate.promise;
      return mediaStream(track);
    });
    let server = false;
    const initiallyPublished: boolean[] = [];
    const command = vi.fn<ConnectionSyncClient["setMicrophoneEnabled"]>(async (enabled) => {
      server = enabled;
      return receipt;
    });
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
      {
        ...platform,
        dependencies: {
          ...platform.dependencies,
          mediaDevices: { getUserMedia: capture },
          createMediaClient: (input) => {
            const media = platform.dependencies.createMediaClient(input);
            return {
              ...media,
              setLocalPublicationTarget: async (target) => {
                track.enabled = target.enabled;
                return { outcome: "confirmed" as const, errorCode: null };
              },
              start: async (stream) => {
                server = stream.getTracks().some((t) => t.kind === track.kind && t.enabled);
                initiallyPublished.push(server);
                await media.start(stream);
              },
            };
          },
          createSyncClient: () => ({ ...platform.sync, setMicrophoneEnabled: command, setCameraEnabled: command }),
        },
      },
    );
    const setEnabled = source === "microphone" ? client.media.setMicrophoneEnabled : client.media.setCameraEnabled;
    try {
      const joining = client.join({ microphone: source === "microphone", camera: source === "camera" });
      await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
      const off = setEnabled(false);
      await drain();
      captureGate.release();
      await Promise.all([joining, off]);
      await drain();
      expect(server, JSON.stringify(command.mock.calls)).toBe(false);
      expect(track.enabled).toBe(false);
      expect(initiallyPublished, "late initial capture must not publish after user Off").toEqual([false]);
    } finally {
      captureGate.release();
      client.dispose();
    }
  });

  it.each(sources)("scopes an explicit host pause to the current %s action", async (source) => {
    const close = vi.fn(async () => undefined);
    const { platform, client, command, track, setEnabled } = createConvergenceScenario(source, { media: { closeForcedLocalPublication: close } });
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      platform.emitMediaPause({ source, revision: 2 });
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(track.enabled).toBe(false);
      await enterRecovery({ platform, client });
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      expect(command.mock.calls.map(([enabled]) => enabled)).toEqual([true]);
      await setEnabled(true);
      platform.emitMediaPause({ source, revision: 2 });
      await drain();
      expect(close).toHaveBeenCalledOnce();
      expect(command.mock.calls.map(([enabled]) => enabled)).toEqual([true, true]);
    } finally {
      client.dispose();
    }
  });

  it.each(sources)("does not apply an old host pause to a queued %s action", async (source) => {
    const pause = barrier();
    const close = vi.fn(async () => {
      await pause.promise;
    });
    const local = vi.fn(async () => ({ outcome: "confirmed" as const, errorCode: null }));
    const { platform, client, command, setEnabled } = createConvergenceScenario(source, { media: { setLocalPublicationTarget: local, closeForcedLocalPublication: close } });
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      const off = setEnabled(false);
      await vi.waitFor(() => expect(close).toHaveBeenCalledExactlyOnceWith(source));
      // The committed control head is the evidence that this stop predates On.
      platform.emitSync({ ...platform.sync.getSnapshot(), control: { ...control, revision: 2 } });
      const on = setEnabled(true);
      await drain();
      platform.emitMediaPause({ source, revision: 2 });
      pause.release();
      await Promise.all([off, on]);
      expect(close).toHaveBeenCalledExactlyOnceWith(source);
      expect(local).not.toHaveBeenCalled();
      expect(command.mock.calls.map(([enabled]) => enabled)).toEqual([true, true]);
    } finally {
      pause.release();
      client.dispose();
    }
  });
});
