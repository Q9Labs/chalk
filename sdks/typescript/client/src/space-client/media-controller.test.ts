import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnosticRuntime } from "../episode-diagnostic-runtime.test.helpers";
import { createMediaControllerHarness, deferred, FakeTrack, stream } from "./media-controller.test.helpers";

describe("MediaController", () => {
  afterEach(() => vi.useRealTimers());

  it("records media success, failure, and unexpected-end checkpoints", async () => {
    const diagnostics = diagnosticRuntime();
    const harness = createMediaControllerHarness(diagnostics);
    const screen = new FakeTrack("screen-diagnostic", "video");
    harness.activate();
    harness.getDisplayMedia.mockResolvedValueOnce(stream(screen));
    await harness.controller.setScreenShareEnabled(true);
    const started = diagnostics.inspect().ring.filter((event) => event.name === "screen.start");
    expect(started.map((event) => event.expectation?.checkpoint)).toEqual(expect.arrayContaining(["permission", "track_acquisition", "sync_commit", "sfu_publication"]));

    screen.endFromBrowser();
    await vi.waitFor(() => expect(diagnostics.inspect().ring.some((event) => event.name === "screen.unexpected_end" && event.state === "succeeded")).toBe(true));

    const failedDiagnostics = diagnosticRuntime();
    const failedHarness = createMediaControllerHarness(failedDiagnostics);
    failedHarness.activate();
    failedHarness.getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await expect(failedHarness.controller.setMicrophoneEnabled(true)).rejects.toBeDefined();
    expect(failedDiagnostics.inspect().ring.at(-1)).toMatchObject({ name: "microphone.publish", state: "failed" });
    diagnostics.dispose();
    failedDiagnostics.dispose();
  });

  it("captures only the configured initial sources and stops unexpected tracks", async () => {
    const harness = createMediaControllerHarness();
    const microphone = new FakeTrack("microphone", "audio");
    const unexpectedCamera = new FakeTrack("camera", "video");
    harness.controller.configure({ microphone: true, camera: false });
    harness.getUserMedia.mockResolvedValueOnce(stream(microphone, unexpectedCamera));

    const initial = await harness.connection.captureInitial({ microphone: true, camera: false });

    expect(harness.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(initial.getTracks()).toEqual([microphone]);
    expect(unexpectedCamera.readyState).toBe("ended");
    expect(harness.store.getSnapshot().media.local.microphone).toMatchObject({ state: "requesting", track: microphone });
  });

  it("projects enumerated capture and output devices", async () => {
    const harness = createMediaControllerHarness();
    harness.enumerateDevices.mockResolvedValueOnce([device("microphone-1", "Desk microphone", "audioinput"), device("camera-1", "Desk camera", "videoinput"), device("speaker-1", "Desk speakers", "audiooutput")]);

    harness.controller.configure({ microphone: true, camera: false });
    harness.getUserMedia.mockResolvedValueOnce(stream(new FakeTrack("microphone", "audio")));
    await harness.connection.captureInitial({ microphone: true, camera: false });

    expect(harness.store.getSnapshot().media.devices).toEqual({
      microphones: [{ deviceId: "microphone-1", label: "Desk microphone" }],
      cameras: [{ deviceId: "camera-1", label: "Desk camera" }],
      speakers: [{ deviceId: "speaker-1", label: "Desk speakers" }],
    });
  });

  it("maps initial and on-demand permission failures to media.permission_denied", async () => {
    const harness = createMediaControllerHarness();
    harness.controller.configure({ microphone: true, camera: false });
    harness.getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));

    await expect(harness.connection.captureInitial({ microphone: true, camera: false })).rejects.toMatchObject({ code: "permission_denied", action: "join" });

    harness.activate();
    harness.getUserMedia.mockRejectedValueOnce(new DOMException("denied", "SecurityError"));
    await expect(harness.controller.setMicrophoneEnabled(true)).rejects.toMatchObject({ code: "media.permission_denied" });
  });

  it("maps an unavailable screen-capture surface to a recoverable user-facing error", async () => {
    const harness = createMediaControllerHarness();
    harness.activate();
    harness.getDisplayMedia.mockRejectedValueOnce(new DOMException("Invalid state", "InvalidStateError"));

    await expect(harness.controller.setScreenShareEnabled(true)).rejects.toMatchObject({ code: "environment.unsupported", message: "Screen sharing is unavailable in this browser." });
  });

  it("serializes overlapping source changes and leaves the source disabled", async () => {
    const harness = createMediaControllerHarness();
    const { capture, enable, microphone } = startMicrophoneCapture(harness, "microphone");
    const disable = harness.controller.setMicrophoneEnabled(false);
    await Promise.resolve();
    expect(harness.getUserMedia).toHaveBeenCalledTimes(1);
    capture.resolve(stream(microphone));
    await Promise.all([enable, disable]);

    expect(harness.sync.setMicrophoneEnabled.mock.calls.map(([enabled]) => enabled)).toEqual([true, false]);
    expect(harness.store.getSnapshot().media.local.microphone).toMatchObject({ state: "disabled", track: microphone });
  });

  it("rolls back a rejected prepared capture and retries an access rejection through the Connection gate", async () => {
    const harness = createMediaControllerHarness();
    const rejected = new FakeTrack("rejected", "audio");
    harness.controller.configure({ microphone: false, camera: false });
    harness.activate();
    harness.getUserMedia.mockResolvedValueOnce(stream(rejected));
    harness.sync.setMicrophoneEnabled.mockRejectedValueOnce(new TypeError("not confirmed"));

    await expect(harness.controller.setMicrophoneEnabled(true)).rejects.toThrow("not confirmed");
    expect(harness.media.clearPreparedLocalTrack).toHaveBeenCalledWith("microphone");
    expect(rejected.readyState).toBe("ended");
    expect(harness.store.getSnapshot().media.local.microphone.state).toBe("disabled");

    const refreshed = new FakeTrack("refreshed", "audio");
    harness.getUserMedia.mockResolvedValueOnce(stream(refreshed));
    harness.sync.setMicrophoneEnabled.mockRejectedValueOnce(Object.assign(new Error("expired"), { code: "access.invalid" }));
    await expect(harness.controller.setMicrophoneEnabled(true)).resolves.toBeUndefined();

    expect(harness.connection.refreshes).toBe(1);
    expect(harness.getUserMedia).toHaveBeenCalledTimes(2);
    expect(harness.sync.setMicrophoneEnabled).toHaveBeenCalledTimes(3);
    expect(harness.store.getSnapshot().media.local.microphone).toMatchObject({ state: "enabled", track: refreshed });
  });

  it("stops capture that resolves after Connection teardown", async () => {
    const harness = createMediaControllerHarness();
    const { capture, enable, microphone } = startMicrophoneCapture(harness, "late");
    await Promise.resolve();
    harness.connection.leave();
    capture.resolve(stream(microphone));

    await expect(enable).rejects.toMatchObject({ code: "invalid_state", action: "setMicrophoneEnabled" });
    expect(microphone.readyState).toBe("ended");
  });

  it("serializes screen starts and clears browser-ended capture only after the Sync target", async () => {
    const harness = createMediaControllerHarness();
    const capture = deferred<MediaStream>();
    const screen = new FakeTrack("screen", "video");
    harness.activate();
    harness.getDisplayMedia.mockReturnValueOnce(capture.promise);

    const first = harness.controller.setScreenShareEnabled(true);
    const second = harness.controller.setScreenShareEnabled(true);
    await Promise.resolve();
    expect(harness.getDisplayMedia).toHaveBeenCalledTimes(1);
    capture.resolve(stream(screen));
    await Promise.all([first, second]);

    expect(harness.sync.setScreenShareEnabled).toHaveBeenCalledTimes(1);
    screen.endFromBrowser();
    await vi.waitFor(() => expect(harness.sync.setScreenShareEnabled).toHaveBeenLastCalledWith(false));
    expect(harness.media.clearPreparedLocalTrack).toHaveBeenCalledWith("screen");
    expect(harness.store.getSnapshot().media.screenShare.track).toBeNull();
  });

  it("defers a screen-end until a recovering Connection returns to live", async () => {
    const harness = createMediaControllerHarness();
    const screen = new FakeTrack("screen", "video");
    harness.activate();
    harness.getDisplayMedia.mockResolvedValueOnce(stream(screen));
    await harness.controller.setScreenShareEnabled(true);
    harness.connection.setState("reconnecting");

    harness.connection.emitScreenEnded();
    await Promise.resolve();
    expect(harness.sync.setScreenShareEnabled).toHaveBeenCalledTimes(1);

    harness.connection.setState("live");
    await vi.waitFor(() => expect(harness.sync.setScreenShareEnabled).toHaveBeenLastCalledWith(false));
    expect(harness.store.getSnapshot().media.screenShare.track).toBeNull();
  });

  it("collapses and expires incoming media requests, exposes the actor name, and accepts through local media", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T08:00:00.000Z"));
    const harness = createMediaControllerHarness();
    const camera = new FakeTrack("camera", "video");
    harness.controller.configure({ microphone: false, camera: false });
    harness.activate();
    harness.sync.setSnapshot(syncSnapshotWithParticipants(["participant-host"]));
    harness.sync.emitRequest(request("request-1", "request_start_camera", 1_000));
    harness.sync.emitRequest(request("request-2", "request_start_camera", 2_000));

    expect(harness.store.getSnapshot().media.incomingRequests).toEqual([expect.objectContaining({ requestId: "request-2", kind: "start_camera", actorDisplayName: "Ada" })]);

    harness.getUserMedia.mockResolvedValueOnce(stream(camera));
    await harness.controller.acceptRequest("request-2");
    expect(harness.sync.setCameraEnabled).toHaveBeenCalledWith(true);
    expect(harness.store.getSnapshot().media.incomingRequests).toEqual([]);

    harness.sync.emitRequest(request("request-3", "request_unmute", 1_000));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(harness.store.getSnapshot().media.incomingRequests).toEqual([]);
  });

  it("removes media requests from actors who leave and projects remote tracks until port teardown", async () => {
    const harness = createMediaControllerHarness();
    const remote = new FakeTrack("remote-camera", "video");
    harness.activate();
    harness.sync.setSnapshot(syncSnapshotWithParticipants(["participant-host"]));
    harness.sync.emitRequest(request("request-1", "request_unmute", 30_000));
    harness.media.setRemoteTracks([{ participantId: "participant-host", source: "camera", publicationId: "camera-1", track: remote as unknown as MediaStreamTrack }]);

    expect(harness.store.getSnapshot().media.remote).toEqual([expect.objectContaining({ participantId: "participant-host", source: "camera", track: remote })]);
    harness.sync.setSnapshot(syncSnapshotWithParticipants([]));
    expect(harness.store.getSnapshot().media.incomingRequests).toEqual([]);

    harness.connection.leave();
    expect(harness.store.getSnapshot().media.remote).toEqual([]);
  });
});

function startMicrophoneCapture(harness: ReturnType<typeof createMediaControllerHarness>, id: string) {
  const capture = deferred<MediaStream>();
  const microphone = new FakeTrack(id, "audio");
  harness.controller.configure({ microphone: false, camera: false });
  harness.activate();
  harness.getUserMedia.mockReturnValueOnce(capture.promise);
  return { capture, enable: harness.controller.setMicrophoneEnabled(true), microphone };
}

function request(requestId: string, name: "request_unmute" | "request_start_camera", expiresInMs: number) {
  return {
    type: "directed_request" as const,
    request_id: requestId,
    name,
    actor_participant_id: "participant-host",
    expires_at_ms: Date.now() + expiresInMs,
  };
}

function device(deviceId: string, label: string, kind: MediaDeviceKind): MediaDeviceInfo {
  return { deviceId, groupId: "group-1", kind, label, toJSON: () => ({}) };
}

function syncSnapshotWithParticipants(participantIds: readonly string[]) {
  return {
    connection: { phase: "live" },
    participantId: "participant-self",
    participantGeneration: 1,
    control: {
      participants: participantIds.map((participantId) => ({ participantId, displayName: participantId === "participant-host" ? "Ada" : participantId })),
    },
    optimisticControl: null,
  } as never;
}
