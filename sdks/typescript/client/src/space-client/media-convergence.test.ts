import { describe, expect, it, vi } from "vitest";
import type { ConnectionSyncClient } from "../connection/dependencies";
import type { V1DirectedRequest } from "../sync/v1-types";
import { V1SyncError } from "../sync/v1-error";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { control, observeMicrophonePublication } from "./terminal.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

describe("SpaceClient media convergence", () => {
  it.each(["microphone", "camera", "screen"] as const)("blocks captured imperative %s enable during health-only recovery", async (source) => {
    const platform = createCoreTestPlatform();
    const track = Object.assign(mediaTrack(), { kind: source === "microphone" ? "audio" : "video" });
    const capture = vi.fn(async () => mediaStream(track));
    const command = vi.fn<ConnectionSyncClient["setMicrophoneEnabled"]>().mockResolvedValue({ operationId: "enable", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" });
    const client = capturedClient(platform, track, { mediaDevices: { getUserMedia: capture, getDisplayMedia: capture }, sync: { setMicrophoneEnabled: command, setCameraEnabled: command, setScreenShareEnabled: command } });
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
    const platform = createCoreTestPlatform();
    const track = Object.assign(mediaTrack(), { kind: "video" });
    const capture = vi.fn(async () => mediaStream(track));
    const enable = vi.fn<ConnectionSyncClient["setCameraEnabled"]>();
    const client = capturedClient(platform, track, { mediaDevices: { getUserMedia: capture }, sync: { setCameraEnabled: enable } });
    try {
      await client.join({ microphone: false, camera: false });
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "recovering" } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
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
    const platform = createCoreTestPlatform();
    const track = Object.assign(mediaTrack(), { kind: source === "microphone" ? "audio" : "video", stop: vi.fn() });
    const command = vi.fn<ConnectionSyncClient["setMicrophoneEnabled"]>().mockResolvedValue({ operationId: "target", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" });
    const client = capturedClient(platform, track, { mediaDevices: { getDisplayMedia: async () => mediaStream(track) }, sync: { setMicrophoneEnabled: command, setCameraEnabled: command, setScreenShareEnabled: command } });
    try {
      await client.join({ microphone: false, camera: false });
      const setEnabled = source === "microphone" ? client.media.setMicrophoneEnabled : source === "camera" ? client.media.setCameraEnabled : client.media.setScreenShareEnabled;
      await setEnabled(true);
      command.mockClear();
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "recovering" } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
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

  it("keeps durable off/on intents ordered while the early local pause is pending", async () => {
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
      expect(command.mock.calls.map(([enabled]) => enabled)).toEqual([false, true]);
      expect(target.mock.calls.filter(([input]) => !input.enabled)).toHaveLength(1);
    } finally {
      finishPause();
      client.dispose();
    }
  });

  it("pauses a local microphone before Sync confirms and restores it when Sync rejects", async () => {
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
      expect(track.enabled).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it.each([false, true])("applies forced off only to the old publication (fresh publication: %s)", async (fresh) => {
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
      expect(close).toHaveBeenCalledTimes(fresh ? 0 : 1);
      expect(track.enabled).toBe(fresh);
      expect(client.getSnapshot().media.local.microphone.state).toBe(fresh ? "enabled" : "disabled");
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
      await client.join({ microphone: false, camera: false });
      await client.media.setScreenShareEnabled(true, { audio: true });
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
      await client.join({ microphone: false, camera: false });
      await client.media.setScreenShareEnabled(true, { audio: true });
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
      await client.join({ microphone: false, camera: false });
      await client.media.setScreenShareEnabled(true, { audio: true });
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
      expect(client.getSnapshot().media.local.microphone.state).toBe("enabled");
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

function mediaTrack(): MediaStreamTrack {
  return Object.assign(new EventTarget(), {
    contentHint: "",
    enabled: true,
    id: "track-1",
    kind: "audio",
    label: "",
    muted: false,
    readyState: "live" as const,
    onended: null,
    onmute: null,
    onunmute: null,
    applyConstraints: async () => undefined,
    clone: mediaTrack,
    getCapabilities: () => ({}),
    getConstraints: () => ({}),
    getSettings: () => ({}),
    stop: () => undefined,
  });
}

function capturedClient(
  platform: ReturnType<typeof createCoreTestPlatform>,
  track: MediaStreamTrack,
  overrides: { readonly mediaDevices?: Partial<NonNullable<typeof platform.dependencies.mediaDevices>>; readonly media?: Partial<ReturnType<typeof platform.dependencies.createMediaClient>>; readonly sync?: Partial<ConnectionSyncClient> } = {},
): ReturnType<typeof createSpaceClientForPlatform> {
  return createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        mediaDevices: { getUserMedia: async () => mediaStream(track), ...overrides.mediaDevices },
        createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), ...overrides.media }),
        createSyncClient: () => ({ ...platform.sync, ...overrides.sync }),
      },
    },
  );
}

function mediaStream(track: MediaStreamTrack): MediaStream {
  return Object.assign(new EventTarget(), {
    active: true,
    id: "stream-1",
    onaddtrack: null,
    onremovetrack: null,
    addTrack: () => undefined,
    removeTrack: () => undefined,
    clone: () => mediaStream(track),
    getTracks: () => [track],
    getAudioTracks: () => (track.kind === "audio" ? [track] : []),
    getVideoTracks: () => (track.kind === "video" ? [track] : []),
    getTrackById: (id: string) => (id === track.id ? track : null),
  });
}
