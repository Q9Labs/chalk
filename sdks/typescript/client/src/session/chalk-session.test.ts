import { describe, expect, it, vi } from "vitest";

import type { CloudflareSFUSnapshot } from "../media";
import type { V3MediaPlaneResult, V3SessionSnapshot } from "../sync";
import type { V3DirectedRequest, V3RoomActionClientEvent } from "../sync/v3-types";
import type { ParticipantAccess } from "./access";
import { ChalkSession } from "./chalk-session";
import type { ChalkSessionAccessRequest, ChalkSessionClock, ChalkSessionDependencies, ChalkSessionMediaFactoryInput, ChalkSessionSyncClient } from "./dependencies";
import type { ChalkSessionDiagnostic } from "./diagnostics";
import type { ChalkSendChatMessageInput } from "./types";

describe("ChalkSession", () => {
  it("acquires permission before access, shares concurrent join, and publishes an immutable live snapshot", async () => {
    const harness = createHarness();
    let releasePermission!: (stream: MediaStream) => void;
    harness.getUserMedia.mockReturnValueOnce(new Promise((resolve) => (releasePermission = resolve)));

    const firstJoin = harness.session.join();
    const secondJoin = harness.session.join();
    expect(secondJoin).toBe(firstJoin);
    expect(harness.access).not.toHaveBeenCalled();

    releasePermission(stream(new FakeTrack("microphone", "audio"), new FakeTrack("camera", "video")));
    await firstJoin;

    expect(harness.access).toHaveBeenCalledTimes(1);
    expect(harness.session.getSnapshot()).toMatchObject({
      state: "live",
      subject: { participantSessionId: "participant-1", participantGeneration: 1 },
      connection: { sync: "healthy", media: "healthy" },
    });
    expect(Object.isFrozen(harness.session.getSnapshot())).toBe(true);
    expect(Object.isFrozen(harness.session.getSnapshot().participants)).toBe(true);
    await harness.session.leave();
  });

  it("does not create participant access when media permission is denied", async () => {
    const harness = createHarness();
    harness.getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));

    await expect(harness.session.join()).rejects.toMatchObject({ code: "permission_denied" });
    expect(harness.access).not.toHaveBeenCalled();
    expect(harness.session.getSnapshot()).toMatchObject({ state: "failed", localMedia: { microphone: { state: "failed" }, camera: { state: "failed" } }, failure: { code: "permission_denied" } });
  });

  it("projects negotiated reactions and acknowledged chat through the canonical Session", async () => {
    const harness = createHarness();
    await harness.session.join();

    await expect(harness.session.sendReaction("🎉")).resolves.toMatchObject({
      eventId: "reaction-1",
      reaction: "🎉",
    });
    await expect(harness.session.sendChatMessage({ text: "Hello" })).resolves.toMatchObject({
      messageId: "message-1",
      text: "Hello",
    });

    expect(harness.session.getSnapshot()).toMatchObject({
      roomActions: {
        phase: "healthy",
        capabilities: ["sendReaction", "sendChat"],
      },
      reactions: [{ eventId: "reaction-1", reaction: "🎉" }],
      chat: {
        status: "ready",
        messages: [{ messageId: "message-1", text: "Hello" }],
        pending: [],
      },
    });
    await harness.session.leave();
  });

  it("sends attachment-only messages and projects monotonic durable read watermarks", async () => {
    const harness = createHarness();
    const attachment = {
      attachmentId: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21",
      fileName: "notes.txt",
      mimeType: "text/plain" as const,
      byteLength: 128,
    };
    await harness.session.join();

    await expect(harness.session.sendChatMessage({ text: "", attachments: [attachment] })).resolves.toMatchObject({
      text: "",
      attachments: [attachment],
    });
    expect(harness.sync.sendChatMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "", attachments: [attachment] }));

    harness.sync.emitRoomAction(chatMessageEvent("2"));
    expect(harness.session.getSnapshot().chat.unreadCount).toBe(1);
    await expect(harness.session.markChatRead("2")).resolves.toMatchObject({ readThroughSequence: "2" });
    expect(harness.session.getSnapshot().chat).toMatchObject({
      unreadCount: 0,
      localReadThroughSequence: "2",
      readReceipts: [expect.objectContaining({ participantSessionId: "participant-1", readThroughSequence: "2" })],
    });

    harness.sync.emitRoomAction({
      type: "chat_read_receipt",
      receipt: {
        participantSessionId: "participant-2",
        participantSessionGeneration: 1,
        readThroughSequence: "2",
        readAt: "2026-07-29T12:01:00.000Z",
      },
    });
    harness.sync.emitRoomAction({
      type: "chat_read_receipt",
      receipt: {
        participantSessionId: "participant-2",
        participantSessionGeneration: 1,
        readThroughSequence: "1",
        readAt: "2026-07-29T12:02:00.000Z",
      },
    });
    expect(harness.session.getSnapshot().chat.readReceipts).toEqual(expect.arrayContaining([expect.objectContaining({ participantSessionId: "participant-2", readThroughSequence: "2" })]));
    await harness.session.leave();
  });

  it("does not count catch-up or live messages at or below the local read watermark as unread", async () => {
    const harness = createHarness();
    await harness.session.join();
    harness.sync.emitRoomAction(chatMessageEvent("2"));
    await harness.session.markChatRead("2");

    harness.sync.emitRoomAction(chatMessageEvent("1"));

    expect(harness.session.getSnapshot().chat).toMatchObject({
      messages: [{ sequence: "1" }, { sequence: "2" }],
      localReadThroughSequence: "2",
      unreadCount: 0,
    });
    await harness.session.leave();
  });

  it("loads initial chat and follows later chat heads without counting history as unread", async () => {
    const harness = createHarness();
    harness.sync.chatHeadSequence = "2";
    harness.sync.readChatPage.mockImplementation(async (input) => {
      const sequence = input.afterSequence === undefined ? "2" : "3";
      harness.sync.emitRoomAction({
        type: "chat_message",
        message: {
          messageId: `message-${sequence}`,
          clientMessageId: `client-message-${sequence}`,
          sequence,
          participantSessionId: "participant-2",
          displayName: "Grace",
          text: `Message ${sequence}`,
          createdAt: "2026-07-29T12:00:00.000Z",
          attachments: [],
        },
      });
      return { status: "loaded", count: 1, hasOlder: input.afterSequence === undefined };
    });

    await harness.session.join();
    await vi.waitFor(() => expect(harness.sync.readChatPage).toHaveBeenCalledWith({ limit: 100 }));
    expect(harness.session.getSnapshot().chat).toMatchObject({
      messages: [{ sequence: "2" }],
      hasOlder: true,
      unreadCount: 0,
    });

    harness.sync.chatHeadSequence = "3";
    harness.sync.emit();
    await vi.waitFor(() => expect(harness.sync.readChatPage).toHaveBeenCalledWith({ afterSequence: "2", limit: 100 }));
    expect(harness.session.getSnapshot().chat).toMatchObject({
      messages: [{ sequence: "2" }, { sequence: "3" }],
      unreadCount: 1,
    });
    await harness.session.leave();
  });

  it("reads bounded newer pages until it reaches the advertised chat head", async () => {
    const harness = createHarness();
    harness.sync.chatHeadSequence = "2";
    harness.sync.readChatPage.mockImplementation(async (input) => {
      const sequence = input.afterSequence === undefined ? "2" : input.afterSequence === "2" ? "3" : "5";
      harness.sync.emitRoomAction(chatMessageEvent(sequence));
      return loadedChatPage(input.afterSequence === "2");
    });

    await joinWithInitialChat(harness, "2");

    harness.sync.chatHeadSequence = "5";
    harness.sync.emit();
    await vi.waitFor(() => expect(harness.sync.readChatPage.mock.calls.map(([input]) => input)).toEqual([{ limit: 100 }, { afterSequence: "2", limit: 100 }, { afterSequence: "3", limit: 100 }]));
    expect(harness.session.getSnapshot().chat).toMatchObject({
      messages: [{ sequence: "2" }, { sequence: "3" }, { sequence: "5" }],
      hasOlder: false,
      unreadCount: 2,
    });
    await harness.session.leave();
  });

  it("reloads the latest chat page after a retained-floor cursor reset", async () => {
    const harness = createHarness();
    let latestPageReads = 0;
    harness.sync.chatHeadSequence = "2";
    harness.sync.readChatPage.mockImplementation(async (input) => {
      if (input.afterSequence !== undefined) {
        harness.sync.emitRoomAction({ type: "chat_cursor_reset", retainedFloorSequence: "8" });
        return { status: "cursor_reset", retainedFloorSequence: "8" };
      }
      latestPageReads += 1;
      harness.sync.emitRoomAction(chatMessageEvent(latestPageReads === 1 ? "2" : "9"));
      return loadedChatPage(latestPageReads === 2);
    });

    await joinWithInitialChat(harness, "2");

    harness.sync.chatHeadSequence = "9";
    harness.sync.emit();
    await vi.waitFor(() => expect(latestPageReads).toBe(2));
    expect(harness.session.getSnapshot().chat).toMatchObject({
      messages: [{ sequence: "2" }, { sequence: "9" }],
      hasOlder: true,
      historyTruncated: true,
      retainedFloorSequence: "8",
      unreadCount: 1,
    });
    await harness.session.leave();
  });

  it("surfaces and accepts a directed start-camera request through confirmed local media", async () => {
    const harness = createHarness({ initialCameraEnabled: false });
    await harness.session.join();
    harness.sync.emitRequest({
      type: "directed_request",
      request_id: "request-000000001",
      name: "request_start_camera",
      actor_participant_session_id: "participant-host",
      expires_at_ms: Date.now() + 30_000,
    });

    expect(harness.session.getSnapshot().incomingMediaRequests).toMatchObject([
      {
        requestId: "request-000000001",
        kind: "start_camera",
        actorParticipantSessionId: "participant-host",
      },
    ]);

    await harness.session.acceptMediaRequest("request-000000001");
    expect(harness.sync.setCameraEnabled).toHaveBeenCalledWith(true);
    expect(harness.session.getSnapshot().incomingMediaRequests).toEqual([]);
    await harness.session.leave();
  });

  it("lets Leave cancel permission acquisition without creating participant access", async () => {
    const harness = createHarness();
    let releasePermission!: (stream: MediaStream) => void;
    harness.getUserMedia.mockReturnValueOnce(new Promise((resolve) => (releasePermission = resolve)));

    const join = harness.session.join();
    const leave = harness.session.leave();
    releasePermission(stream(new FakeTrack("microphone", "audio"), new FakeTrack("camera", "video")));

    await expect(join).rejects.toMatchObject({ code: "invalid_state" });
    await expect(leave).resolves.toBeUndefined();
    expect(harness.access).not.toHaveBeenCalled();
    expect(harness.session.getSnapshot().state).toBe("left");
  });

  it("attempts durable Leave after a startup failure and exposes unconfirmed cleanup", async () => {
    const harness = createHarness({ failMediaStart: true, failLeave: true });

    await expect(harness.session.join()).rejects.toMatchObject({ code: "join_cleanup_unconfirmed" });
    expect(harness.sync.leave).toHaveBeenCalledTimes(1);
    expectLowerLayersStopped(harness);
  });

  it("reports the failed startup layer when durable cleanup succeeds", async () => {
    const harness = createHarness({ failMediaStart: true });

    await expect(harness.session.join()).rejects.toMatchObject({ code: "media_start_failed" });
    expect(harness.sync.leave).toHaveBeenCalledTimes(1);
    expect(harness.session.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "media_start_failed" } });
  });

  it("shares concurrent Leave and tears down tracks, observers, media, and Sync", async () => {
    const harness = createHarness();
    await harness.session.join();

    const firstLeave = harness.session.leave();
    const secondLeave = harness.session.leave();
    expect(secondLeave).toBe(firstLeave);
    await firstLeave;

    expect(harness.sync.leave).toHaveBeenCalledTimes(1);
    expectLowerLayersStopped(harness);
    expect(harness.session.getSnapshot()).toMatchObject({ state: "left", connection: { sync: "stopped", media: "stopped" } });
    expect(harness.session.getDiagnostics().at(-1)).toMatchObject({ event: "state_changed", state: "left" });
  });

  it("reuses one media client and requests replacement access only for SFU recovery", async () => {
    const { harness, initial, replacement } = await joinedRecoveryHarness();

    harness.media.failRecoverably();
    await vi.waitFor(() => expect(harness.media.restart).toHaveBeenCalledWith(replacement.media.clientPayload));
    await waitForLive(harness.session);

    expect(harness.createMediaClient).toHaveBeenCalledTimes(1);
    expect(harness.access.mock.calls[1]?.[0]).toMatchObject({
      reason: "media_recovery",
      replaceMediaConnection: true,
      currentMediaToken: initial.media.token,
    } satisfies Partial<ChalkSessionAccessRequest>);
    await harness.session.leave();
  });

  it("handles one failed immutable media snapshot once when subscription and onFailure both deliver it", async () => {
    const { harness } = await joinedRecoveryHarness();

    harness.media.failRecoverablyThroughBothSignals();
    await waitForLive(harness.session);

    expect(harness.media.restart).toHaveBeenCalledTimes(1);
    expect(harness.access).toHaveBeenCalledTimes(2);
    await harness.session.leave();
  });

  it("keeps local-publication and remote-poll errors operation-scoped when onFailure re-reads the live snapshot", async () => {
    const harness = createHarness();
    await harness.session.join();

    harness.media.reportOperationError("local publication failed");
    harness.media.reportOperationError("remote publication poll failed");
    await Promise.resolve();

    expect(harness.session.getSnapshot()).toMatchObject({ state: "live", connection: { media: "healthy" } });
    expect(harness.media.restart).not.toHaveBeenCalled();
    expect(harness.access).toHaveBeenCalledTimes(1);
    await harness.session.leave();
  });

  it("recreates only Sync after a terminal Sync result and keeps the participant access connection", async () => {
    const harness = createHarness();
    await harness.session.join();

    harness.sync.enterTerminal();
    await vi.waitFor(() => expect(harness.createSyncClient).toHaveBeenCalledTimes(2));
    await waitForLive(harness.session);

    expect(harness.createMediaClient).toHaveBeenCalledTimes(1);
    expect(harness.access).toHaveBeenCalledTimes(1);
    await harness.session.leave();
  });

  it("moves to failed after three media recovery attempts", async () => {
    const harness = createHarness({
      failMediaRestart: true,
      access: [participantAccess("connection-1", "initial"), participantAccess("connection-2", "retry-1"), participantAccess("connection-3", "retry-2"), participantAccess("connection-4", "retry-3")],
      recoveryBackoffMs: [0],
    });
    await harness.session.join();

    harness.media.failRecoverably();
    await vi.waitFor(() => expect(harness.session.getSnapshot()).toMatchObject({ state: "failed", failure: { code: "media_recovery_exhausted" } }));

    expect(harness.media.restart).toHaveBeenCalledTimes(3);
    expect(harness.session.getDiagnostics().some((event) => event.event === "recovery_exhausted" && event.attempt === undefined)).toBe(true);
    await harness.session.leave();
  });

  it("preserves a media recovery queued while another media recovery is active", async () => {
    const harness = createHarness({
      access: [participantAccess("connection-1", "initial"), participantAccess("connection-2", "first-recovery"), participantAccess("connection-3", "queued-recovery")],
    });
    const firstRestart = deferred<void>();
    harness.media.restart.mockImplementationOnce(() => firstRestart.promise);
    await harness.session.join();

    harness.media.failRecoverably();
    await vi.waitFor(() => expect(harness.media.restart).toHaveBeenCalledTimes(1));
    harness.media.failRecoverably();
    harness.media.makeLive();
    firstRestart.resolve();

    await vi.waitFor(() => expect(harness.media.restart).toHaveBeenCalledTimes(2));
    await waitForLive(harness.session);
    expect(harness.access).toHaveBeenCalledTimes(3);
    await harness.session.leave();
  });

  it("rejects rejoin during failed-runtime cleanup and permits it after old resources are stopped", async () => {
    let session!: ChalkSession;
    let rejoinDuringCleanup: Promise<void> | null = null;
    const harness = createHarness({
      failMediaRestart: true,
      maxRecoveryAttempts: 1,
      recoveryBackoffMs: [0],
      onDiagnostic: (event) => {
        if (event.event === "state_changed" && event.state === "failed") {
          rejoinDuringCleanup = session.join();
          void rejoinDuringCleanup.catch(() => undefined);
        }
      },
    });
    session = harness.session;
    await session.join();

    harness.media.failRecoverably();
    await vi.waitFor(() => expect(rejoinDuringCleanup).not.toBeNull());
    await expect(rejoinDuringCleanup!).rejects.toMatchObject({ code: "invalid_state" });
    await vi.waitFor(() => expect(harness.media.stop).toHaveBeenCalledTimes(1));

    await expect(session.join()).resolves.toBeUndefined();
    expect(harness.createMediaClient).toHaveBeenCalledTimes(2);
    await session.leave();
  });

  it.each(["access", "media", "sync"] as const)("bounds a never-settling %s recovery operation by the remaining deadline", async (blockedLayer) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00.000Z"));
    try {
      const harness = createHarness({ maxRecoveryAttempts: 1, recoveryBudgetMs: 25, clock: systemClock() });
      await harness.session.join();
      blockRecovery(harness, blockedLayer);

      if (blockedLayer === "sync") harness.sync.enterTerminal();
      else harness.media.failRecoverably();
      await vi.advanceTimersByTimeAsync(26);

      expect(harness.session.getSnapshot()).toMatchObject({ state: "failed", failure: { code: blockedLayer === "sync" ? "sync_recovery_exhausted" : "media_recovery_exhausted" } });
      expect(harness.media.stop).toHaveBeenCalledTimes(1);
      expect(harness.sync.stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes browser-ended screen sharing through the Sync v3 target before clearing the track", async () => {
    const harness = createHarness();
    await harness.session.join();
    const screen = new FakeTrack("screen", "video");
    harness.getDisplayMedia.mockResolvedValueOnce(stream(screen));

    await harness.session.startScreenShare();
    expect(harness.sync.setScreenShareEnabled).toHaveBeenCalledWith(true);
    harness.media.endScreen();
    await vi.waitFor(() => expect(harness.sync.setScreenShareEnabled).toHaveBeenCalledWith(false));
    await vi.waitFor(() => expect(harness.session.getSnapshot().localMedia.screen.track).toBeNull());
    expect(screen.readyState).toBe("ended");
    await harness.session.leave();
  });

  it("serializes concurrent screen-share starts into one owned capture and publication", async () => {
    const harness = createHarness();
    const capture = deferred<MediaStream>();
    const screen = new FakeTrack("concurrent-screen", "video");
    harness.getDisplayMedia.mockReturnValueOnce(capture.promise);
    await harness.session.join();

    const first = harness.session.startScreenShare();
    const second = harness.session.startScreenShare();
    await Promise.resolve();
    expect(harness.getDisplayMedia).toHaveBeenCalledTimes(1);
    capture.resolve(stream(screen));
    await Promise.all([first, second]);

    expect(harness.getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(harness.sync.setScreenShareEnabled).toHaveBeenCalledTimes(1);
    expect(harness.session.getSnapshot().localMedia.screen.track).toBe(screen);
    await harness.session.stopScreenShare();
    expect(screen.readyState).toBe("ended");
    await harness.session.leave();
  });

  it("maps the public moderation methods to confirmed Sync commands", async () => {
    const harness = createHarness();
    await harness.session.join();

    await harness.session.setHandRaised(true);
    await harness.session.setMicrophoneEnabled(false);
    await harness.session.setCameraEnabled(false);
    await harness.session.setDisplayName("Ada");
    await harness.session.setAdmissionPolicy("approval");
    await harness.session.setParticipantRole("participant-2", "cohost");
    await harness.session.transferHost("participant-2");
    await harness.session.admitParticipant("admission-1");
    await harness.session.denyAdmission("admission-2");
    await harness.session.muteParticipant("participant-2");
    await harness.session.stopParticipantCamera("participant-2");
    await harness.session.stopParticipantScreenShare("participant-2");
    await harness.session.removeParticipant("participant-2");
    await harness.session.endSession();

    expect(harness.sync.setDisplayName).toHaveBeenCalledWith("Ada");
    expect(harness.sync.setMicrophoneEnabled).toHaveBeenCalledWith(false);
    expect(harness.sync.setCameraEnabled).toHaveBeenCalledWith(false);
    expect(harness.sync.setParticipantRole).toHaveBeenCalledWith("participant-2", "cohost");
    expect(harness.sync.endSession).toHaveBeenCalledTimes(1);
    await harness.session.leave();
  });

  it.each([
    { source: "microphone", action: "setMicrophoneEnabled", syncName: "set_microphone_enabled" },
    { source: "camera", action: "setCameraEnabled", syncName: "set_camera_enabled" },
  ] as const)("publishes a new immutable snapshot after $action is confirmed", async ({ source, action, syncName }) => {
    const harness = createHarness();
    await harness.session.join();
    const before = harness.session.getSnapshot();
    const applyTarget = async (enabled: boolean) => {
      await harness.media.setLocalPublicationTarget({ source, enabled });
      return mediaTargetResult(syncName);
    };
    if (source === "microphone") harness.sync.setMicrophoneEnabled.mockImplementationOnce(applyTarget);
    else harness.sync.setCameraEnabled.mockImplementationOnce(applyTarget);

    await harness.session[action](false);

    const after = harness.session.getSnapshot();
    expect(after).not.toBe(before);
    expect(Object.isFrozen(after)).toBe(true);
    expect(after.localMedia[source]).toMatchObject({ state: "disabled", track: harness.tracks[source === "microphone" ? 0 : 1] });
    expect(harness.media.setLocalPublicationTarget).toHaveBeenCalledWith({ source, enabled: false });
    await harness.session.leave();
  });

  it("acquires a disabled source on demand and maps rejected commands to a stable error", async () => {
    const harness = createHarness({ initialMicrophoneEnabled: false, initialCameraEnabled: false });
    await harness.session.join();
    expect(harness.getUserMedia).not.toHaveBeenCalled();

    const microphone = new FakeTrack("microphone-on-demand", "audio");
    harness.getUserMedia.mockResolvedValueOnce(stream(microphone));
    await harness.session.setMicrophoneEnabled(true);
    expect(harness.session.getSnapshot().localMedia.microphone.track).toBe(microphone);

    harness.sync.setDisplayName.mockRejectedValueOnce(new TypeError("server rejected"));
    await expect(harness.session.setDisplayName("Rejected")).rejects.toMatchObject({ code: "command_rejected", action: "setDisplayName" });
    await harness.session.leave();
  });

  it("serializes overlapping microphone enable and disable without orphaning or resurrecting capture", async () => {
    const harness = createHarness({ initialMicrophoneEnabled: false, initialCameraEnabled: false });
    const capture = deferred<MediaStream>();
    const microphone = new FakeTrack("serialized-microphone", "audio");
    harness.getUserMedia.mockReturnValueOnce(capture.promise);
    await harness.session.join();

    const enable = harness.session.setMicrophoneEnabled(true);
    const disable = harness.session.setMicrophoneEnabled(false);
    await Promise.resolve();
    expect(harness.getUserMedia).toHaveBeenCalledTimes(1);
    capture.resolve(stream(microphone));
    await Promise.all([enable, disable]);

    expect(harness.sync.setMicrophoneEnabled.mock.calls.map(([enabled]) => enabled)).toEqual([true, false]);
    expect(harness.session.getSnapshot().localMedia.microphone).toMatchObject({ state: "disabled", track: microphone });
    await harness.session.leave();
    expect(microphone.readyState).toBe("ended");
  });

  it("stops on-demand capture returned after Leave and permits a clean rejoin", async () => {
    const harness = createHarness({ initialMicrophoneEnabled: false, initialCameraEnabled: false });
    const capture = deferred<MediaStream>();
    const lateMicrophone = new FakeTrack("late-microphone", "audio");
    harness.getUserMedia.mockReturnValueOnce(capture.promise);
    await harness.session.join();

    const enable = harness.session.setMicrophoneEnabled(true);
    await Promise.resolve();
    await harness.session.leave();
    capture.resolve(stream(lateMicrophone));

    await expect(enable).rejects.toMatchObject({ code: "invalid_state", action: "setMicrophoneEnabled" });
    expect(lateMicrophone.readyState).toBe("ended");
    await Promise.resolve();
    await expect(harness.session.join()).resolves.toBeUndefined();
    expect(harness.createMediaClient).toHaveBeenCalledTimes(2);
    await harness.session.leave();
  });

  it("finishes local cleanup and rejects Leave when the durable acknowledgement fails", async () => {
    const harness = createHarness({ failLeave: true });
    await harness.session.join();

    await expect(harness.session.leave()).rejects.toMatchObject({ code: "leave_unconfirmed" });
    expect(harness.session.getSnapshot()).toMatchObject({ state: "left", failure: { code: "leave_unconfirmed" } });
    expect(harness.tracks.every((track) => track.readyState === "ended")).toBe(true);
  });
});

function loadedChatPage(hasOlder: boolean) {
  return { status: "loaded" as const, count: 1, hasOlder };
}

async function joinWithInitialChat(harness: ReturnType<typeof createHarness>, sequence: string): Promise<void> {
  await harness.session.join();
  await vi.waitFor(() => expect(harness.session.getSnapshot().chat.messages).toMatchObject([{ sequence }]));
}

function createHarness(
  options: {
    readonly failMediaStart?: boolean;
    readonly failMediaRestart?: boolean;
    readonly failLeave?: boolean;
    readonly access?: readonly ParticipantAccess[];
    readonly initialMicrophoneEnabled?: boolean;
    readonly initialCameraEnabled?: boolean;
    readonly recoveryBackoffMs?: readonly number[];
    readonly maxRecoveryAttempts?: number;
    readonly recoveryBudgetMs?: number;
    readonly clock?: ChalkSessionClock;
    readonly onDiagnostic?: (event: ChalkSessionDiagnostic) => void;
  } = {},
) {
  const tracks = [new FakeTrack("microphone", "audio"), new FakeTrack("camera", "video")];
  const getUserMedia = vi.fn().mockResolvedValue(stream(...tracks));
  const getDisplayMedia = vi.fn();
  const accesses = [...(options.access ?? [participantAccess("connection-1", "initial")])];
  const access = vi.fn(async () => accesses.shift() ?? participantAccess("connection-1", "refreshed"));
  const media = new FakeMedia(options.failMediaStart ?? false, options.failMediaRestart ?? false);
  const sync = new FakeSync(options.failLeave ?? false);
  const createMediaClient = vi.fn((_input: ChalkSessionMediaFactoryInput) => {
    media.callbacks = _input;
    return media;
  });
  const createSyncClient = vi.fn(() => sync);
  const dependencies: ChalkSessionDependencies = {
    clock: options.clock ?? {
      now: () => Date.parse("2026-07-21T12:00:00.000Z"),
      setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    mediaDevices: { getUserMedia, getDisplayMedia },
    createMediaClient,
    createSyncClient,
  };
  const session = new ChalkSession({
    access,
    apiBaseURL: "http://localhost:8080",
    syncURL: "ws://localhost:4000/v3",
    initialMicrophoneEnabled: options.initialMicrophoneEnabled,
    initialCameraEnabled: options.initialCameraEnabled,
    recovery: { backoffMs: options.recoveryBackoffMs, maxAttempts: options.maxRecoveryAttempts, budgetMs: options.recoveryBudgetMs },
    diagnostics: { onEvent: options.onDiagnostic },
    dependencies,
  });
  return { session, access, media, sync, createMediaClient, createSyncClient, getUserMedia, getDisplayMedia, tracks };
}

async function joinedRecoveryHarness() {
  const initial = participantAccess("connection-1", "initial");
  const replacement = participantAccess("connection-2", "replacement");
  const harness = createHarness({ access: [initial, replacement] });
  await harness.session.join();
  return { harness, initial, replacement };
}

function expectLowerLayersStopped(harness: ReturnType<typeof createHarness>): void {
  expect(harness.sync.stop).toHaveBeenCalledTimes(1);
  expect(harness.media.stop).toHaveBeenCalledTimes(1);
  expect(harness.tracks.every((track) => track.readyState === "ended")).toBe(true);
}

async function waitForLive(session: ChalkSession): Promise<void> {
  await vi.waitFor(() => expect(session.getSnapshot().state).toBe("live"));
}

function blockRecovery(harness: ReturnType<typeof createHarness>, layer: "access" | "media" | "sync"): void {
  const never = new Promise<never>(() => undefined);
  if (layer === "access") harness.access.mockReturnValueOnce(never);
  else if (layer === "media") harness.media.restart.mockReturnValueOnce(never);
  else harness.sync.start.mockReturnValueOnce(never);
}

function systemClock(): ChalkSessionClock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => (resolve = complete));
  return { promise, resolve };
}

function chatMessageEvent(sequence: string): V3RoomActionClientEvent {
  return {
    type: "chat_message",
    message: {
      messageId: `message-${sequence}`,
      clientMessageId: `client-message-${sequence}`,
      sequence,
      participantSessionId: "participant-2",
      displayName: "Grace",
      text: `Message ${sequence}`,
      createdAt: "2026-07-29T12:00:00.000Z",
      attachments: [],
    },
  };
}

class FakeMedia {
  callbacks!: ChalkSessionMediaFactoryInput;
  readonly restart = vi.fn(async () => {
    if (this.failRestart) throw new TypeError("restart failed");
    this.snapshot = mediaSnapshot("live");
    this.emit();
  });
  readonly stop = vi.fn(() => {
    for (const track of this.localTracks.values()) track.stop();
    this.snapshot = mediaSnapshot("stopped");
  });
  readonly listeners = new Set<() => void>();
  readonly localTracks = new Map<string, MediaStreamTrack>();
  snapshot = mediaSnapshot("idle");

  constructor(
    readonly failStart: boolean,
    readonly failRestart: boolean,
  ) {}

  start = vi.fn(async (input: MediaStream) => {
    for (const track of input.getTracks()) this.localTracks.set(track.kind === "audio" ? "microphone" : "camera", track);
    if (this.failStart) throw new TypeError("media failed");
    this.snapshot = mediaSnapshot("live", this.localTracks);
    this.emit();
  });
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  prepareLocalTrack = (source: string, track: MediaStreamTrack) => {
    this.localTracks.set(source, track);
  };
  clearPreparedLocalTrack = vi.fn(async (source: string) => {
    this.localTracks.get(source)?.stop();
    this.localTracks.delete(source);
    this.snapshot = mediaSnapshot("live", this.localTracks);
    this.emit();
  });
  setLocalPublicationTarget = vi.fn(async (target: { readonly source: string; readonly enabled: boolean }): Promise<V3MediaPlaneResult> => {
    this.snapshot = mediaSnapshot("live", this.localTracks, target.source, target.enabled);
    this.emit();
    return { outcome: "confirmed", errorCode: null };
  });
  observeLocalPublications = () => () => undefined;
  observeRemotePublications = () => () => undefined;
  failRecoverably() {
    this.snapshot = { ...mediaSnapshot("failed"), failure: { code: "peer_connection_failed", recoverable: true } };
    this.emit();
  }
  failRecoverablyThroughBothSignals() {
    this.failRecoverably();
    this.callbacks.onFailure(new TypeError("peer connection failed"));
  }
  reportOperationError(message: string) {
    this.callbacks.onFailure(new TypeError(message));
  }
  makeLive() {
    this.snapshot = mediaSnapshot("live", this.localTracks);
    this.emit();
  }
  endScreen() {
    this.callbacks.onScreenEnded();
  }
  emit() {
    for (const listener of this.listeners) listener();
  }
}

class FakeSync implements ChalkSessionSyncClient {
  readonly listeners = new Set<(snapshot: V3SessionSnapshot) => void>();
  readonly requestListeners = new Set<(request: V3DirectedRequest) => void>();
  readonly roomActionListeners = new Set<(event: V3RoomActionClientEvent) => void>();
  snapshot = syncSnapshot("idle");
  chatHeadSequence: string | null = null;
  constructor(readonly failLeave: boolean) {}
  start = vi.fn(async () => {
    this.snapshot = syncSnapshot("live");
    this.emit();
  });
  stop = vi.fn(() => {
    this.snapshot = syncSnapshot("stopped");
  });
  getSnapshot = () => this.snapshot;
  subscribe = (listener: (snapshot: V3SessionSnapshot) => void) => {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  };
  getRoomActionsExtensionState = () => ({
    negotiated: this.snapshot.connection.phase === "live",
    version: this.snapshot.connection.phase === "live" ? (2 as const) : null,
    capabilities: ["sendReaction", "sendChat"] as const,
    chatHeadSequence: this.chatHeadSequence,
    retainedFloorSequence: null,
    readReceipts: [],
  });
  getParticipantRoomActionCapabilities = () => ({
    "participant-1": ["sendReaction", "sendChat"] as const,
  });
  subscribeRoomActions = (listener: (event: V3RoomActionClientEvent) => void) => {
    this.roomActionListeners.add(listener);
    return () => this.roomActionListeners.delete(listener);
  };
  sendReaction = vi.fn(async (reaction: "👍" | "❤️" | "😂" | "😮" | "😢" | "🎉") => ({
    eventId: "reaction-1",
    participantSessionId: "participant-1",
    displayName: "Ada",
    reaction,
    occurredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
  }));
  sendChatMessage = vi.fn(async (input: ChalkSendChatMessageInput) => ({
    messageId: "message-1",
    clientMessageId: input.clientMessageId ?? "chat-message-1",
    sequence: "1",
    participantSessionId: "participant-1",
    displayName: "Ada",
    text: input.text,
    createdAt: new Date().toISOString(),
    attachments: input.attachments ?? [],
  }));
  markChatRead = vi.fn(async (sequence: string) => ({
    participantSessionId: "participant-1",
    participantSessionGeneration: 1,
    readThroughSequence: sequence,
    readAt: new Date().toISOString(),
  }));
  readChatPage = vi.fn(async () => ({ status: "loaded" as const, count: 0, hasOlder: false }));
  onDirectedRequest = (listener: (request: V3DirectedRequest) => void) => {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  };
  requestUnmute = vi.fn(async () => ({ type: "directed_request_result" as const, request_id: "request-1", result: "delivered" as const }));
  requestStartCamera = vi.fn(async () => ({ type: "directed_request_result" as const, request_id: "request-1", result: "delivered" as const }));
  emitRequest(request: V3DirectedRequest) {
    for (const listener of this.requestListeners) listener(request);
  }
  emitRoomAction(event: V3RoomActionClientEvent) {
    for (const listener of this.roomActionListeners) listener(event);
  }
  leave = vi.fn(async () => {
    if (this.failLeave) throw new TypeError("leave failed");
    return commandResult();
  });
  setMicrophoneEnabled = vi.fn(async () => mediaTargetResult("set_microphone_enabled"));
  setCameraEnabled = vi.fn(async () => mediaTargetResult("set_camera_enabled"));
  setScreenShareEnabled = vi.fn(async () => mediaTargetResult("set_screen_share_enabled"));
  setHandRaised = vi.fn(async () => commandResult());
  setDisplayName = vi.fn(async () => commandResult());
  setAdmissionPolicy = vi.fn(async () => commandResult());
  setParticipantRole = vi.fn(async () => commandResult());
  transferHost = vi.fn(async () => commandResult());
  admit = vi.fn(async () => commandResult());
  deny = vi.fn(async () => commandResult());
  muteParticipant = vi.fn(async () => commandResult());
  stopParticipantCamera = vi.fn(async () => commandResult());
  stopParticipantScreenShare = vi.fn(async () => commandResult());
  removeParticipant = vi.fn(async () => commandResult());
  endSession = vi.fn(async () => commandResult());
  enterTerminal() {
    this.snapshot = syncSnapshot("terminal");
    this.emit();
  }
  emit() {
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

class FakeTrack extends EventTarget {
  enabled = true;
  readyState: MediaStreamTrackState = "live";
  constructor(
    readonly id: string,
    readonly kind: "audio" | "video",
  ) {
    super();
  }
  stop() {
    this.readyState = "ended";
  }
}

function stream(...tracks: FakeTrack[]): MediaStream {
  return {
    getTracks: () => tracks as unknown as MediaStreamTrack[],
    getVideoTracks: () => tracks.filter((track) => track.kind === "video") as unknown as MediaStreamTrack[],
  } as MediaStream;
}

function participantAccess(connectionId: string, suffix: string): ParticipantAccess {
  const expiresAt = "2026-07-21T12:05:00.000Z";
  return {
    subject: { tenantId: "tenant-1", roomId: "room-1", sessionId: "session-1", participantSessionId: "participant-1", participantGeneration: 1 },
    sync: { token: token("chalk-sync", suffix), expiresAt },
    media: { token: token("chalk-media", suffix), expiresAt, provider: "cloudflare_sfu", clientPayload: { connectionId, stunServer: "stun:stun.cloudflare.com:3478" } },
  };
}

function token(audience: "chalk-sync" | "chalk-media", suffix: string) {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${encode({ alg: "EdDSA" })}.${encode({ aud: audience })}.${suffix}` as ParticipantAccess["sync"]["token"] & ParticipantAccess["media"]["token"];
}

function syncSnapshot(phase: V3SessionSnapshot["connection"]["phase"]): V3SessionSnapshot {
  return {
    connection: { phase },
    participantSessionId: phase === "live" ? "participant-1" : null,
    participantSessionGeneration: phase === "live" ? 1 : null,
    control: null,
    optimisticControl: null,
    media: null,
    presence: null,
    mediaPlane: { local: [], remote: [] },
    localMedia: { microphone: "unknown", camera: "unknown", screen: "unknown" },
    pendingCommandCount: 0,
  };
}

function mediaSnapshot(phase: CloudflareSFUSnapshot["connection"]["phase"], tracks = new Map<string, MediaStreamTrack>(), changedSource?: string, changedEnabled?: boolean): CloudflareSFUSnapshot {
  return {
    connection: { phase, peerConnectionState: null, iceConnectionState: null },
    cursor: null,
    localTracks: [...tracks].map(([source, track]) => ({ source: source as "microphone" | "camera" | "screen", enabled: source === changedSource ? (changedEnabled ?? true) : true, publicationId: `${source}-publication`, track })),
    remoteTracks: [],
    failure: null,
  };
}

function commandResult() {
  return { type: "ack", command_id: "command-1", outcome: "satisfied", revision: 1, state_digest: "digest" } as const;
}

function mediaTargetResult(name: "set_microphone_enabled" | "set_camera_enabled" | "set_screen_share_enabled") {
  return { operationId: "operation-1", name, serverOutcome: "confirmed", mediaPlaneOutcome: "confirmed" } as const;
}
