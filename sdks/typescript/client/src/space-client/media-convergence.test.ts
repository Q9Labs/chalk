import { capturedClient, createConvergenceScenario, enterRecovery, mediaStream, mediaTrack } from "../../tests/helpers/media-convergence";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionSyncClient } from "../connection/dependencies";
import type { V1DirectedRequest } from "../sync/v1-types";
import { V1SyncError } from "../sync/v1-error";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { control, observeMicrophonePublication } from "./terminal.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

describe("SpaceClient media convergence", () => {
  it("reports a camera command interrupted by leaving without exposing internals", async () => {
    const platform = createCoreTestPlatform();
    const track = Object.assign(mediaTrack(), { kind: "video" });
    let finish: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const command = vi.fn(async () => {
      await pending;
      return { operationId: "camera-on", name: "set_camera_enabled" as const, serverOutcome: "confirmed" as const, mediaPlaneOutcome: "confirmed" as const };
    });
    const client = capturedClient(platform, track, { sync: { setCameraEnabled: command } });
    try {
      await client.join({ microphone: false, camera: false });
      const enabling = client.media.setCameraEnabled(true);
      const result = expect(enabling).rejects.toMatchObject({ code: "connection.invalid_state" });
      await vi.waitFor(() => expect(command).toHaveBeenCalledOnce());
      await client.leave();
      finish();
      await result;
    } finally {
      finish();
      client.dispose();
    }
  });

  it.each(["microphone", "camera", "screen"] as const)("keeps rejected %s Off paused and reconciles it after recovery", async (source) => {
    const localTargets: boolean[] = [];
    const { platform, command, client, setEnabled, track } = createConvergenceScenario(source, {
      media: {
        setLocalPublicationTarget: async (target) => {
          localTargets.push(target.enabled);
          return { outcome: "confirmed", errorCode: null };
        },
      },
    });
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      command.mockRejectedValueOnce(new V1SyncError("capability_denied", "terminal_failure"));
      await expect(setEnabled(false)).rejects.toBeDefined();
      expect(track.enabled).toBe(false);
      expect(localTargets).toEqual([false]);
      await enterRecovery({ platform, client });
      command.mockClear();
      await resumeWithOff({ platform, command });
      expect(localTargets).not.toContain(true);
      expect(track.enabled).toBe(false);
      command.mockClear();
      await setEnabled(true);
      expect(command).toHaveBeenCalledWith(true);
    } finally {
      client.dispose();
    }
  });

  it.each(["microphone", "camera", "screen"] as const)("blocks captured imperative %s enable during health-only recovery", async (source) => {
    const { platform, capture, command, client } = createConvergenceScenario(source);
    try {
      await client.join({ microphone: false, camera: false });
      const { setMicrophoneEnabled, setCameraEnabled, setScreenShareEnabled } = client.media;
      const enable = source === "microphone" ? setMicrophoneEnabled : source === "camera" ? setCameraEnabled : setScreenShareEnabled;
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live", noticeUnresponsive: true } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
      await expect(enable(true)).rejects.toMatchObject({ code: "connection.invalid_state", recoverable: true });
      expect(capture).not.toHaveBeenCalled();
      expect(command).not.toHaveBeenCalled();
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live", health: "degraded" } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      await expect(enable(true)).resolves.toBeUndefined();
      expect(capture).toHaveBeenCalledTimes(1);
      expect(command).toHaveBeenCalledWith(true);
    } finally {
      client.dispose();
    }
  });

  it("keeps private camera preview available during recovery without publishing", async () => {
    const { platform, track, capture, command: enable, client } = createConvergenceScenario("camera");
    try {
      await client.join({ microphone: false, camera: false });
      await enterRecovery({ platform, client });
      const preview = await client.media.captureCameraPreview();
      expect(preview.track).toBe(track);
      expect(capture).toHaveBeenCalledOnce();
      await expect(client.media.setCameraEnabled(true)).rejects.toMatchObject({ code: "connection.invalid_state" });
      expect(enable).not.toHaveBeenCalled();
      preview.release();
    } finally {
      client.dispose();
    }
  });

  it.each(["microphone", "camera", "screen"] as const)("reconciles the latest %s off intent once Sync is live again", async (source) => {
    const { platform, track, command, client, setEnabled } = createConvergenceScenario(source);
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      command.mockClear();
      await enterRecovery({ platform, client });
      await setEnabled(false);
      expect(command).not.toHaveBeenCalled();
      if (source === "screen") expect(track.stop).toHaveBeenCalled();
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
      await vi.waitFor(() => expect(command).toHaveBeenCalledWith(false));
      expect(command).toHaveBeenCalledTimes(1);
      platform.emitSync({ ...platform.sync.getSnapshot() });
      await setEnabled(true);
      expect(command.mock.calls.map(([enabled]) => enabled)).toEqual([false, true]);
    } finally {
      client.dispose();
    }
  });

  it.each(
    (["microphone", "camera", "screen"] as const).flatMap((source) => [
      { source, queued: 1, newerStop: false },
      { source, queued: 2, newerStop: false },
      { source, queued: 1, newerStop: true },
    ]),
  )("retains $source off behind $queued queued enables (newer Stop: $newerStop)", async ({ source, queued, newerStop }) => {
    let holdPause = false;
    let finishPause = () => {};
    const paused = new Promise<void>((resolve) => {
      finishPause = resolve;
    });
    const target = vi.fn(async (input: { readonly enabled: boolean }) => {
      track.enabled = input.enabled;
      if (holdPause && !input.enabled) await paused;
      return { outcome: "confirmed" as const, errorCode: null };
    });
    const { platform, track, command, client, setEnabled } = createConvergenceScenario(source, { media: { setLocalPublicationTarget: target } });
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      command.mockClear();
      target.mockClear();
      holdPause = true;
      const off = setEnabled(false);
      await vi.waitFor(() => expect(target).toHaveBeenCalledTimes(1));
      const on = Array.from({ length: queued }, () =>
        setEnabled(true).then(
          () => null,
          (error: unknown) => error,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const latestOff = newerStop ? setEnabled(false) : Promise.resolve();
      await vi.waitFor(() => expect(target).toHaveBeenCalledTimes(newerStop ? 2 : 1));
      await enterRecovery({ platform, client });
      finishPause();
      await Promise.all([off, latestOff]);
      const results = await Promise.all(on);
      if (!newerStop) for (const result of results) expect(result).toMatchObject({ code: "connection.invalid_state" });
      expect(command.mock.calls.map(([enabled]) => enabled)).not.toContain(true);
      command.mockClear();
      await resumeWithOff({ platform, command });
    } finally {
      finishPause();
      client.dispose();
    }
  });

  it.each(["microphone", "camera", "screen"] as const)("preserves %s off when enabling fails after passing its guard", async (source) => {
    const { platform, command, client, setEnabled } = createConvergenceScenario(source);
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      command.mockRejectedValue(new V1SyncError("Acknowledgement unavailable", "not_live"));
      await expect(setEnabled(false)).rejects.toMatchObject({ code: "connection.invalid_state" });
      await expect(setEnabled(true)).rejects.toMatchObject({ code: "connection.invalid_state" });
      await enterRecovery({ platform, client });
      command.mockReset().mockResolvedValue({ operationId: "off", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" });
      await resumeWithOff({ platform, command });
    } finally {
      client.dispose();
    }
  });

  it.each(["microphone", "camera", "screen"] as const)("keeps newer %s Stop after an older enable result arrives", async (source) => {
    const { platform, command, client, setEnabled } = createConvergenceScenario(source);
    let finishEnable = () => {};
    const ack = new Promise<void>((resolve) => {
      finishEnable = resolve;
    });
    try {
      await client.join({ microphone: false, camera: false });
      command.mockImplementationOnce(async () => {
        await ack;
        return { operationId: "old-enable", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" };
      });
      const enabling = setEnabled(true).catch((error) => error);
      await vi.waitFor(() => expect(command).toHaveBeenCalledWith(true));
      const stopping = setEnabled(false);
      await enterRecovery({ platform, client });
      finishEnable();
      await Promise.all([enabling, stopping]);
      command.mockClear();
      await resumeWithOff({ platform, command });
    } finally {
      finishEnable();
      client.dispose();
    }
  });

  it.each(["picker", "off-ack"] as const)("keeps Stop desired while a replacement is waiting for %s", async (barrier) => {
    const platform = createCoreTestPlatform();
    const original = Object.assign(mediaTrack(), { id: "original", kind: "video" });
    const replacement = Object.assign(mediaTrack(), { id: "replacement", kind: "video", stop: vi.fn() });
    let finishPicker = () => {};
    const picker = new Promise<MediaStream>((resolve) => {
      finishPicker = () => resolve(mediaStream(replacement));
    });
    const getDisplayMedia = vi
      .fn()
      .mockResolvedValueOnce(mediaStream(original))
      .mockReturnValueOnce(barrier === "picker" ? picker : Promise.resolve(mediaStream(replacement)));
    let finishOff = () => {};
    const offAck = new Promise<void>((resolve) => {
      finishOff = resolve;
    });
    let server = false;
    let locallyPaused = false;
    let generation = 0;
    const receipt = { operationId: "replacement", name: "set_screen_share_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" } as const;
    const command = vi.fn<ConnectionSyncClient["setScreenShareEnabled"]>(async (enabled) => {
      server = enabled;
      const publicationId = enabled ? `publication-${++generation}` : null;
      if (!enabled && barrier === "off-ack") await offAck;
      // A successful server enable holds the screen lease before local publication.
      // A paused local source can reject that publication after the server grant.
      if (!enabled || generation === 1) {
        if (enabled) platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ source: "screen", enabled, publicationId, track: original }] });
        platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "media-1", sequence: generation + (enabled ? 0 : 1), items: [{ participantId: "participant-1", source: "screen", enabled, publicationId }] } });
      }
      if (enabled && locallyPaused) throw new V1SyncError("local_source_paused", "terminal_failure");
      return receipt;
    });
    const client = capturedClient(platform, original, {
      mediaDevices: { getDisplayMedia },
      media: {
        setLocalSourceIntent: (_source, enabled) => {
          locallyPaused = !enabled;
        },
      },
      sync: { setScreenShareEnabled: command },
    });
    try {
      await client.join({ microphone: false, camera: false });
      await client.media.setScreenShareEnabled(true);
      command.mockClear();
      const replacing = client.media.setScreenShareEnabled(true, { surface: "window" }).catch((e) => e);
      await vi.waitFor(() => expect(getDisplayMedia).toHaveBeenCalledTimes(2));
      if (barrier === "off-ack") await vi.waitFor(() => expect(command).toHaveBeenCalledWith(false));
      const stopping = client.media.setScreenShareEnabled(false).catch((e) => e);
      await new Promise((resolve) => setTimeout(resolve, 30));
      finishPicker();
      finishOff();
      await Promise.all([replacing, stopping]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "recovering" } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(replacement.stop).toHaveBeenCalled();
      expect(server, JSON.stringify(command.mock.calls.map(([v]) => v))).toBe(false);
      expect(command.mock.calls.map(([v]) => v)).toEqual(barrier === "off-ack" ? [false, false] : [false]);
    } finally {
      finishPicker();
      finishOff();
      client.dispose();
    }
  });

  it("lets the access backend replace the media binding requested by SFU recovery", async () => {
    const platform = createCoreTestPlatform();
    let replace = async (): Promise<unknown> => {
      throw new Error("Media recovery is not bound");
    };
    const getAccess = vi.fn(async (context: { readonly replaceMediaConnection?: boolean }) => opaqueAccessGrant("test", "test", context.replaceMediaConnection ? "connection-2" : "connection-1"));
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess },
      {
        ...platform,
        dependencies: {
          ...platform.dependencies,
          createMediaClient: (input) => {
            replace = input.replaceMediaConnection!;
            return platform.dependencies.createMediaClient(input);
          },
        },
      },
    );
    try {
      await client.join({ microphone: false, camera: false });
      await expect(replace()).resolves.toMatchObject({ provider: "cloudflare_sfu", clientPayload: { connectionId: "connection-2" } });
      expect(getAccess.mock.calls.map(([context]) => context.replaceMediaConnection)).toEqual([false, true]);
    } finally {
      client.dispose();
    }
  });

  it("awaits the early local pause then sends only the latest desired state", async () => {
    const platform = createCoreTestPlatform();
    const track = mediaTrack();
    let finishPause: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      finishPause = resolve;
    });
    const target = vi.fn(async (input: { readonly enabled: boolean }) => {
      track.enabled = input.enabled;
      if (!input.enabled) await pending;
      return { outcome: "confirmed" as const, errorCode: null };
    });
    const command = vi.fn<ConnectionSyncClient["setMicrophoneEnabled"]>().mockResolvedValue({ operationId: "toggle", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" });
    const client = capturedClient(platform, track, { media: { setLocalPublicationTarget: target }, sync: { setMicrophoneEnabled: command } });
    try {
      await client.join({ microphone: true, camera: false });
      command.mockClear();
      const off = client.media.setMicrophoneEnabled(false);
      await vi.waitFor(() => expect(target).toHaveBeenCalledWith(expect.objectContaining({ enabled: false })));
      const on = client.media.setMicrophoneEnabled(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const commandsBeforePause = command.mock.calls.length;
      finishPause();
      await Promise.all([off, on]);
      expect(commandsBeforePause).toBe(0);
      expect(command.mock.calls.map(([enabled]) => enabled)).toEqual([true]);
      expect(target.mock.calls.filter(([input]) => !input.enabled)).toHaveLength(1);
    } finally {
      finishPause();
      client.dispose();
    }
  });

  it("keeps a local microphone paused when Sync rejects its Off command", async () => {
    const platform = createCoreTestPlatform();
    const track = mediaTrack();
    let rejectSync: (reason: Error) => void = () => undefined;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectSync = reject;
    });
    const target = vi.fn(async (input: { readonly enabled: boolean }) => {
      track.enabled = input.enabled;
      platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ source: "microphone", enabled: input.enabled, publicationId: "publication-1", track }] });
      return { outcome: "confirmed" as const, errorCode: null };
    });
    const command = vi.fn(() => pending);
    const client = capturedClient(platform, track, { media: { setLocalPublicationTarget: target }, sync: { setMicrophoneEnabled: command } });
    try {
      await client.join({ microphone: true, camera: false });
      platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ source: "microphone", enabled: true, publicationId: "publication-1", track }] });
      const muting = client.media.setMicrophoneEnabled(false);
      await vi.waitFor(() => expect(command).toHaveBeenCalledOnce());
      expect(track.enabled).toBe(false);
      expect(target.mock.calls[0]?.[0].enabled).toBe(false);
      rejectSync(new V1SyncError("Sync rejected the media change", "terminal_failure"));
      await expect(muting).rejects.toThrow("Sync rejected the media change");
      expect(track.enabled).toBe(false);
    } finally {
      client.dispose();
    }
  });

  it.each([false, true])("keeps healthy tracks but waits for an off projection to converge (fresh publication: %s)", async (fresh) => {
    const platform = createCoreTestPlatform();
    const track = mediaTrack();
    const close = vi.fn(async () => {
      track.enabled = false;
      platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ source: "microphone", enabled: false, publicationId: null, track }] });
    });
    const client = capturedClient(platform, track, { media: { closeForcedLocalPublication: close } });
    try {
      await client.join({ microphone: true, camera: false });
      const active = observeMicrophonePublication(platform, track, { publicationId: fresh ? "fresh-publication" : "old-publication" });
      platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "media-1", sequence: 2, items: [{ ...active, enabled: false, publicationId: null }] } });
      expect(close).not.toHaveBeenCalled();
      expect(track.enabled).toBe(true);
      expect(client.getSnapshot().media.local.microphone.state).toBe("requesting");
    } finally {
      client.dispose();
    }
  });

  it("applies revoked media while the self row is absent from the control roster", async () => {
    const platform = createCoreTestPlatform();
    const track = mediaTrack();
    const close = vi.fn(async () => undefined);
    const client = capturedClient(platform, track, { media: { closeForcedLocalPublication: close } });
    try {
      await client.join({ microphone: true, camera: false });
      observeMicrophonePublication(platform, track, { control: { ...control, participants: [] } });
      platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "media-1", sequence: 2, items: [] } });
      platform.emitMediaPause({ source: "microphone", revision: 2 });
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(client.getSnapshot().connection.status).toBe("live");
    } finally {
      client.dispose();
    }
  });

  it("does not close a revoked publication after an Episode end", async () => {
    const platform = createCoreTestPlatform();
    const track = mediaTrack();
    const close = vi.fn(async () => undefined);
    const stop = vi.spyOn(track, "stop");
    const client = capturedClient(platform, track, { media: { closeForcedLocalPublication: close } });
    try {
      await client.join({ microphone: true, camera: false });
      observeMicrophonePublication(platform, track, { control });
      platform.emitSync({ ...platform.sync.getSnapshot(), control: { ...control, status: "ended", participants: [] }, media: { projectionId: "media-1", sequence: 2, items: [] } });
      expect(close).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("left"));
      expect(stop).toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it.each(["microphone", "screen_audio"] as const)("gates an attached remote %s track on the same projection as the muted state", async (source) => {
    const platform = createCoreTestPlatform();
    const track = mediaTrack();
    const client = createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, platform);
    try {
      await client.join({ microphone: false, camera: false });
      const publication = { participantId: "participant-2", source: source === "screen_audio" ? ("screen" as const) : source, enabled: true, publicationId: "publication-2" };
      platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "media-1", sequence: 1, items: [publication] } });
      platform.media.emit({ ...platform.media.getSnapshot(), remoteTracks: [{ ...publication, source, track }] });
      expect(track.enabled).toBe(true);
      platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "media-1", sequence: 2, items: [{ ...publication, enabled: false }] } });
      expect(track.enabled).toBe(false);
      expect(client.getSnapshot().media.remote[0]?.track).toBe(track);
      platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "media-1", sequence: 3, items: [publication] } });
      expect(track.enabled).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it.each(["accept", "decline", "expired"] as const)("requires target consent for an unmute request: %s", async (decision) => {
    const platform = createCoreTestPlatform();
    const track = mediaTrack();
    const capture = vi.fn(async () => mediaStream(track));
    let receive = (_request: V1DirectedRequest): void => {
      throw new Error("Request listener is not bound");
    };
    const enable = vi.fn<ConnectionSyncClient["setMicrophoneEnabled"]>(async () => {
      platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ source: "microphone", enabled: true, publicationId: "publication-1", track }] });
      return { operationId: "unmute-1", name: "set_microphone_enabled", serverOutcome: "confirmed", mediaPlaneOutcome: "confirmed" };
    });
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
      {
        ...platform,
        dependencies: {
          ...platform.dependencies,
          mediaDevices: { getUserMedia: capture },
          createSyncClient: () => ({
            ...platform.sync,
            setMicrophoneEnabled: enable,
            onDirectedRequest: (listener) => {
              receive = listener;
              return () => undefined;
            },
          }),
        },
      },
    );
    try {
      await client.join({ microphone: false, camera: false });
      receive({ type: "directed_request", request_id: "request-1", name: "request_unmute", actor_participant_id: "requester-1", expires_at_ms: decision === "expired" ? 1 : Date.now() + 30_000 });
      expect(capture).not.toHaveBeenCalled();
      if (decision === "accept") {
        await client.media.acceptRequest("request-1");
        expect(capture).toHaveBeenCalledOnce();
        expect(client.getSnapshot().media.local.microphone.state).toBe("requesting");
        observeMicrophonePublication(platform, track);
        expect(client.getSnapshot().media.local.microphone.state).toBe("enabled");
      } else if (decision === "decline") {
        await client.media.declineRequest("request-1");
        expect(capture).not.toHaveBeenCalled();
      } else {
        await expect(client.media.acceptRequest("request-1")).rejects.toMatchObject({ code: "media.request_invalid" });
        expect(capture).not.toHaveBeenCalled();
      }
      expect(client.getSnapshot().media.incomingRequests).toHaveLength(0);
    } finally {
      client.dispose();
    }
  });

  it.each(["monitor", "window", "browser"] as const)("forwards a %s picker hint through the public share action and reports the actual source", async (surface) => {
    const platform = createCoreTestPlatform();
    const track = Object.assign(mediaTrack(), { kind: "video", label: "Slides", getSettings: () => ({ displaySurface: "window" }), stop: vi.fn() });
    const stream = Object.assign(mediaStream(track), { getVideoTracks: () => [track], getAudioTracks: () => [] });
    const getDisplayMedia = vi.fn(async (_constraints: DisplayMediaStreamOptions) => stream);
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("share-hint") },
      {
        ...platform,
        dependencies: {
          ...platform.dependencies,
          mediaDevices: { ...platform.dependencies.mediaDevices, getDisplayMedia },
          createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), prepareLocalTrack: () => undefined, clearPreparedLocalTrack: async () => undefined }),
          createSyncClient: () => ({ ...platform.sync, setScreenShareEnabled: async () => ({ operationId: "share-hint", name: "set_screen_share_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" }) }),
        },
      },
    );
    try {
      await client.join({ microphone: false, camera: false });
      await client.media.setScreenShareEnabled(true, { surface, audio: surface === "browser" });
      expect(getDisplayMedia).toHaveBeenCalledWith({
        video: { displaySurface: surface },
        audio: surface === "browser" ? { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
        systemAudio: "exclude",
      });
      expect(client.getSnapshot().media.screenShare.capture).toEqual({ surface: "window", label: "Slides" });
      await client.media.setScreenShareEnabled(false);
      expect(client.getSnapshot().media.screenShare.capture).toBeUndefined();
      expect(track.stop).toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it.each(["cancel", "deny", "replace", "publish-failure"] as const)("keeps the original capture until replacement succeeds: %s", async (outcome) => {
    const platform = createCoreTestPlatform();
    const oldVideo = Object.assign(mediaTrack(), { kind: "video", label: "Original", stop: vi.fn(), getSettings: () => ({ displaySurface: "window" }) });
    const oldAudio = Object.assign(mediaTrack(), { kind: "audio", stop: vi.fn() });
    const newVideo = Object.assign(mediaTrack(), { kind: "video", label: "Replacement", stop: vi.fn(), getSettings: () => ({ displaySurface: "browser" }) });
    const newAudio = Object.assign(mediaTrack(), { kind: "audio", stop: vi.fn() });
    newVideo.stop.mockImplementation(() => {
      Object.assign(newVideo, { readyState: "ended" });
    });
    newAudio.stop.mockImplementation(() => {
      Object.assign(newAudio, { readyState: "ended" });
    });
    const stream = (video: MediaStreamTrack, audio: MediaStreamTrack[]) => Object.assign(mediaStream(video), { getVideoTracks: () => [video], getAudioTracks: () => audio, getTracks: () => [video, ...audio] });
    let complete!: (stream: MediaStream) => void;
    let fail!: (error: Error) => void;
    const picker = new Promise<MediaStream>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    const getDisplayMedia = vi
      .fn()
      .mockResolvedValueOnce(stream(oldVideo, [oldAudio]))
      .mockReturnValueOnce(picker);
    const prepare = vi.fn();
    const clear = vi.fn(async () => undefined);
    const share = vi.fn(async (enabled: boolean) => {
      if (enabled && getDisplayMedia.mock.calls.length === 2 && outcome === "publish-failure") throw new Error("Replacement publication failed");
      return { operationId: "share", name: "set_screen_share_enabled" as const, serverOutcome: "satisfied" as const, mediaPlaneOutcome: "satisfied" as const };
    });
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("replace-share") },
      {
        ...platform,
        dependencies: {
          ...platform.dependencies,
          mediaDevices: { ...platform.dependencies.mediaDevices, getDisplayMedia },
          createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), prepareLocalTrack: prepare, clearPreparedLocalTrack: clear }),
          createSyncClient: () => ({ ...platform.sync, setScreenShareEnabled: share }),
        },
      },
    );
    try {
      await joinWithSharedAudio(client);
      const replacement = client.media.setScreenShareEnabled(true, { surface: "browser" });
      await vi.waitFor(() => expect(getDisplayMedia).toHaveBeenCalledTimes(2));
      expect(clear).not.toHaveBeenCalled();
      expect(oldVideo.stop).not.toHaveBeenCalled();
      expect(oldAudio.stop).not.toHaveBeenCalled();
      if (outcome === "replace") {
        complete(stream(newVideo, [newAudio]));
        await replacement;
        expect(newVideo.stop).not.toHaveBeenCalled();
        expect(newAudio.stop).not.toHaveBeenCalled();
        expect(prepare).toHaveBeenCalledWith("screen", newVideo);
        expect(oldVideo.stop).toHaveBeenCalledOnce();
        expect(oldAudio.stop).toHaveBeenCalledOnce();
        expect(client.getSnapshot().media.screenShare.capture?.label).toBe("Replacement");
      } else if (outcome === "publish-failure") {
        const rejected = expect(replacement).rejects.toBeDefined();
        complete(stream(newVideo, [newAudio]));
        await rejected;
        expect(newVideo.stop).toHaveBeenCalledOnce();
        expect(newAudio.stop).toHaveBeenCalledOnce();
        expect(newVideo.readyState).toBe("ended");
        expect(newAudio.readyState).toBe("ended");
        client.dispose();
        expect(newVideo.stop).toHaveBeenCalledOnce();
        expect(newAudio.stop).toHaveBeenCalledOnce();
      } else {
        const rejected = outcome === "deny" ? expect(replacement).rejects.toMatchObject({ code: "media.permission_denied" }) : expect(replacement).rejects.toBeDefined();
        fail(new DOMException("Picker failed", outcome === "cancel" ? "AbortError" : "NotAllowedError"));
        await rejected;
        expect(clear).not.toHaveBeenCalled();
        expect(oldVideo.stop).not.toHaveBeenCalled();
        expect(oldAudio.stop).not.toHaveBeenCalled();
        expect(client.getSnapshot().media.screenShare.capture?.label).toBe("Original");
        expect(share).toHaveBeenCalledTimes(1);
      }
    } finally {
      client.dispose();
    }
  });

  it.each(["leave-retirement", "dispose-retirement", "leave-picker", "dispose-picker"] as const)("stops uncommitted replacement captures on %s", async (scenario) => {
    const platform = createCoreTestPlatform();
    const oldVideo = Object.assign(mediaTrack(), { kind: "video", stop: vi.fn() });
    const oldAudio = Object.assign(mediaTrack(), { kind: "audio", stop: vi.fn() });
    const video = Object.assign(mediaTrack(), { kind: "video", stop: vi.fn() });
    const audio = Object.assign(mediaTrack(), { kind: "audio", stop: vi.fn() });
    const stream = (v: MediaStreamTrack, a: MediaStreamTrack) => Object.assign(mediaStream(v), { getVideoTracks: () => [v], getAudioTracks: () => [a], getTracks: () => [v, a] });
    let finishCapture!: (captured: MediaStream) => void;
    const picker = new Promise<MediaStream>((resolve) => {
      finishCapture = resolve;
    });
    let finishRetirement!: () => void;
    const retirement = new Promise<void>((resolve) => {
      finishRetirement = resolve;
    });
    const getDisplayMedia = vi.fn().mockResolvedValueOnce(stream(oldVideo, oldAudio)).mockReturnValueOnce(picker);
    const clear = vi.fn(async (source: string) => {
      if (source === "screen_audio" && scenario.endsWith("retirement")) await retirement;
    });
    const client = capturedClient(platform, oldVideo, {
      mediaDevices: { getDisplayMedia },
      media: { prepareLocalTrack: () => undefined, clearPreparedLocalTrack: clear },
      sync: { setScreenShareEnabled: async () => ({ operationId: "share", name: "set_screen_share_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" }) },
    });
    try {
      await joinWithSharedAudio(client);
      const replacement = client.media.setScreenShareEnabled(true, { audio: true }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(getDisplayMedia).toHaveBeenCalledTimes(2));
      if (scenario.endsWith("retirement")) {
        finishCapture(stream(video, audio));
        await vi.waitFor(() => expect(clear).toHaveBeenCalledWith("screen_audio"));
      }
      if (scenario.startsWith("leave")) await client.leave();
      else client.dispose();
      finishCapture(stream(video, audio));
      finishRetirement();
      expect(await replacement).toBeDefined();
      expect(video.stop).toHaveBeenCalled();
      expect(audio.stop).toHaveBeenCalled();
    } finally {
      finishCapture(stream(video, audio));
      finishRetirement();
      client.dispose();
    }
  });

  it("reports remote share audio only while both share publications are active", async () => {
    const platform = createCoreTestPlatform();
    const client = createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, platform);
    try {
      await client.join({ microphone: false, camera: false });
      const snapshot = platform.sync.getSnapshot();
      const sharedControl = { ...control, participants: control.participants.flatMap((participant) => [participant, { ...participant, participantId: "participant-2" }]) };
      const items = [{ participantId: "participant-2", source: "screen" as const, enabled: true, publicationId: "screen" }];
      platform.emitSync({ ...snapshot, control: sharedControl, media: { projectionId: "media-1", sequence: 1, items } });
      const track = mediaTrack();
      platform.media.emit({ ...platform.media.getSnapshot(), remoteTracks: [{ participantId: "participant-2", source: "screen_audio", publicationId: "audio", track }] });
      expect(client.getSnapshot().participants.roster.find((participant) => participant.participantId === "participant-2")?.media.screenShareHasAudio).toBe(true);
      platform.emitSync({ ...snapshot, control: sharedControl, media: { projectionId: "media-1", sequence: 2, items: items.map((item) => ({ ...item, enabled: false })) } });
      expect(client.getSnapshot().participants.roster.find((participant) => participant.participantId === "participant-2")?.media.screenShareHasAudio).toBe(false);
    } finally {
      client.dispose();
    }
  });

  it.each(["live", "recovering", "stalled", "audio-failure"] as const)("fully stops display video and audio while Sync is %s", async (phase) => {
    const platform = createCoreTestPlatform();
    const video = Object.assign(mediaTrack(), { kind: "video", label: "Tab", getSettings: () => ({ displaySurface: "browser" }), stop: vi.fn() });
    const audio = Object.assign(mediaTrack(), { kind: "audio", stop: vi.fn() });
    const stream = Object.assign(mediaStream(video), { getTracks: () => [video, audio], getVideoTracks: () => [video], getAudioTracks: () => [audio] });
    let releaseStop: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const prepare = vi.fn();
    let failAudio = false;
    const clear = vi.fn(async (source: string) => {
      if (source === "screen_audio" && failAudio) throw new Error("audio cleanup failed");
    });
    const getUserMedia = vi.fn(platform.dependencies.mediaDevices.getUserMedia);
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("share-audio") },
      {
        ...platform,
        dependencies: {
          ...platform.dependencies,
          mediaDevices: { ...platform.dependencies.mediaDevices, getUserMedia, getDisplayMedia: async () => stream },
          createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), prepareLocalTrack: prepare, clearPreparedLocalTrack: clear }),
          createSyncClient: () => ({
            ...platform.sync,
            setScreenShareEnabled: async (enabled) => {
              if (!enabled && phase === "stalled") await stopped;
              return { operationId: "share", name: "set_screen_share_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" };
            },
          }),
        },
      },
    );
    try {
      await joinWithSharedAudio(client);
      expect(prepare).toHaveBeenCalledWith("screen_audio", audio);
      expect(prepare).toHaveBeenCalledWith("screen", video);
      expect(audio.stop).not.toHaveBeenCalled();
      platform.media.emit({
        ...platform.media.getSnapshot(),
        localTracks: [
          { source: "screen", enabled: true, publicationId: "video", track: video },
          { source: "screen_audio", enabled: true, publicationId: "audio", track: audio },
        ],
      });
      expect(client.getSnapshot().media.screenShare.hasAudio).toBe(true);
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: phase === "recovering" ? "recovering" : "live" } });
      failAudio = phase === "audio-failure";
      const stop = client.media.setScreenShareEnabled(false);
      const result = failAudio ? expect(stop).rejects.toThrow("audio cleanup failed") : expect(stop).resolves.toBeUndefined();
      await vi.waitFor(() => {
        expect(video.stop).toHaveBeenCalled();
        expect(audio.stop).toHaveBeenCalled();
      });
      releaseStop();
      await result;
      expect(clear).toHaveBeenCalledWith("screen_audio");
      expect(clear).toHaveBeenCalledWith("screen");
      expect(audio.stop).toHaveBeenCalled();
      expect(video.stop).toHaveBeenCalled();
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(client.getSnapshot().media.screenShare.hasAudio).toBe(false);
    } finally {
      releaseStop();
      client.dispose();
    }
  });

  it.each(["microphone", "camera"] as const)("turns off local %s without waiting for recovering Sync", async (source) => {
    const platform = createCoreTestPlatform();
    const track = Object.assign(mediaTrack(), { kind: source === "camera" ? "video" : "audio" });
    const target = vi.fn(async (input: { readonly enabled: boolean }) => {
      track.enabled = input.enabled;
      return { outcome: "confirmed" as const, errorCode: null };
    });
    const command = vi.fn<ConnectionSyncClient["setMicrophoneEnabled"]>().mockResolvedValue({ operationId: "set", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" });
    const client = capturedClient(platform, track, { media: { setLocalPublicationTarget: target }, sync: { setMicrophoneEnabled: command, setCameraEnabled: command } });
    try {
      await client.join({ microphone: source === "microphone", camera: source === "camera" });
      command.mockClear();
      target.mockClear();
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "recovering" } });
      await expect(source === "camera" ? client.media.setCameraEnabled(false) : client.media.setMicrophoneEnabled(false)).resolves.toBeUndefined();
      expect(target).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
      expect(track.enabled).toBe(false);
      expect(command).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it("sends an authoritative stop even when no local screen capture is retained", async () => {
    const platform = createCoreTestPlatform();
    const stop = vi.fn<ConnectionSyncClient["setScreenShareEnabled"]>().mockResolvedValue({ operationId: "stop-1", name: "set_screen_share_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" });
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
      {
        ...platform,
        dependencies: { ...platform.dependencies, createSyncClient: () => ({ ...platform.sync, setScreenShareEnabled: stop }) },
      },
    );
    try {
      await client.join({ microphone: false, camera: false });
      await client.media.setScreenShareEnabled(false);
      expect(stop).toHaveBeenCalledWith(false);
      expect(client.getSnapshot().media.screenShare.state).toBe("disabled");
    } finally {
      client.dispose();
    }
  });

  it("shows a disabled provider publication as muted after moderation", async () => {
    const platform = createCoreTestPlatform();
    const track = mediaTrack();
    const client = capturedClient(platform, track);
    try {
      await client.join({ microphone: true, camera: false });
      platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ source: "microphone", enabled: true, publicationId: "publication-1", track }] });
      expect(client.getSnapshot().media.local.microphone.state).toBe("requesting");
      platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ source: "microphone", enabled: false, publicationId: null, track }] });
      expect(client.getSnapshot().media.local.microphone.state).toBe("disabled");
    } finally {
      client.dispose();
    }
  });

  it.each([
    ["NotFoundError", "media.device_not_found"],
    ["NotAllowedError", "media.permission_denied"],
    ["NotReadableError", "media.device_busy"],
    ["OverconstrainedError", "media.device_constraint_invalid"],
    ["NotSupportedError", "environment.unsupported"],
    ["AbortError", "media.capture_failed"],
  ])("preserves the recovery for %s at the public capture boundary", async (name, code) => {
    const platform = createCoreTestPlatform();
    const client = createSpaceClientForPlatform(
      { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
      {
        ...platform,
        dependencies: {
          ...platform.dependencies,
          mediaDevices: {
            getUserMedia: async () => {
              throw new DOMException("capture failed", name);
            },
          },
        },
      },
    );
    try {
      await client.join({ microphone: false, camera: false });
      await expect(client.media.setMicrophoneEnabled(true)).rejects.toMatchObject({ code });
    } finally {
      client.dispose();
    }
  });
});

async function joinWithSharedAudio(client: ReturnType<typeof createSpaceClientForPlatform>) {
  await client.join({ microphone: false, camera: false });
  await client.media.setScreenShareEnabled(true, { audio: true });
}

async function resumeWithOff({ platform, command }: Pick<ReturnType<typeof createConvergenceScenario>, "platform" | "command">) {
  platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
  await vi.waitFor(() => expect(command.mock.calls.map(([enabled]) => enabled)).toEqual([false]));
}
