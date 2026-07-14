import { describe, expect, it } from "vitest";
import { SnapshotSchema } from "../generated/sync-v3";
import { decodeV3ServerFrame } from "./v3-codec";
import { V3SyncClient, V3SyncError } from "./v3-client";
import { InMemoryV3PendingTargetStore } from "./v3-persistence";
import { AsyncStorageV3PendingTargetStore, IndexedDbV3PendingTargetStore } from "./v3-platform-persistence";
import { applyV3Event, computeV3StateDigest, restoreV3Snapshot, snapshotToState, V3ReplicaError } from "./v3-reducer";
import type { SyncSocket, SyncWebSocketFactory } from "./types";
import type { V3ClientMediaPlane, V3ControlState, V3MediaPlaneResult, V3MediaPlaneTarget, V3MediaPublication, V3PendingTarget, V3PendingTargetStore, V3SessionSnapshot } from "./v3-types";

type Snapshot = typeof SnapshotSchema.Type;

const hostId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";
const peerId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22";
const recoveryId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23";
const projectionId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c24";
const commandIds = Array.from({ length: 20 }, (_, index) => `018f2f65-2a77-7a44-8e9a-${(0x5b0b6f8d4d00 + index).toString(16)}`);

describe("V3SyncClient", () => {
  it("allows startup to be retried after pending-target restoration fails", async () => {
    const store = new FailOnceLoadStore();
    const sockets: TestSocket[] = [];
    const client = new V3SyncClient({
      url: "ws://sync.test/v3/sync",
      token: async () => "token",
      pendingStore: store,
      webSocket: {
        connect: () => {
          const socket = new TestSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    await expect(client.start()).rejects.toThrow("pending store unavailable");
    await expect(client.start()).resolves.toBeUndefined();
    expect(store.loadAttempts).toBe(2);
    expect(sockets).toHaveLength(1);
    client.stop();
  });

  it("preserves a durable command queued while a failing startup load is in flight", async () => {
    const store = new RejectableLoadStore();
    const client = new V3SyncClient({
      url: "ws://sync.test/v3/sync",
      token: async () => "token",
      pendingStore: store,
      webSocket: { connect: () => new TestSocket() },
    });

    const startup = client.start();
    const target = client.setHandRaised(true, { commandId: commandIds[0] });
    let settlement = "pending";
    void target.then(
      () => {
        settlement = "resolved";
      },
      (error: unknown) => {
        settlement = error instanceof V3SyncError ? error.code : "unexpected";
      },
    );
    await settle();
    expect(client.getSnapshot().pendingCommandCount).toBe(1);

    store.rejectLoad();
    await expect(startup).rejects.toThrow("pending store unavailable");
    expect(client.getSnapshot().pendingCommandCount).toBe(1);
    await client.start();
    client.stop();
    await settle();

    expect(settlement).toBe("client_stopped");
    expect(await store.load()).toHaveLength(1);
  });

  it("does not install observers or connect when stopped during pending-target restoration", async () => {
    const store = new BlockingLoadStore();
    const mediaPlane = new CountingMediaPlane();
    let lifecycleSubscriptions = 0;
    let socketConnections = 0;
    const client = new V3SyncClient({
      url: "ws://sync.test/v3/sync",
      token: async () => "token",
      pendingStore: store,
      mediaPlane,
      lifecycle: {
        subscribe: () => {
          lifecycleSubscriptions += 1;
          return () => undefined;
        },
      },
      webSocket: {
        connect: () => {
          socketConnections += 1;
          return new TestSocket();
        },
      },
    });

    const startup = client.start();
    client.stop();
    store.completeLoad();
    await startup;

    expect(mediaPlane.observerSubscriptions).toBe(0);
    expect(lifecycleSubscriptions).toBe(0);
    expect(socketConnections).toBe(0);
    expect(client.getSnapshot().connection.phase).toBe("stopped");
  });

  it("uses browser-legal application close codes for client-initiated restarts", async () => {
    const transportSocket = new TestSocket();
    const transportClient = new V3SyncClient({
      url: "ws://sync.test/v3/sync",
      token: async () => "token",
      webSocket: { connect: () => transportSocket },
    });
    await transportClient.start();
    transportSocket.error();
    expect(transportSocket.closeCalls).toEqual([{ code: 4000, reason: "transport error" }]);

    const authenticationSocket = new TestSocket();
    const authenticationClient = new V3SyncClient({
      url: "ws://sync.test/v3/sync",
      token: async () => Promise.reject(new Error("token unavailable")),
      webSocket: { connect: () => authenticationSocket },
    });
    await authenticationClient.start();
    authenticationSocket.open();
    await settle();
    expect(authenticationSocket.closeCalls).toEqual([{ code: 4000, reason: "authentication failed" }]);

    const clock = new TestClock();
    const { socket: heartbeatSocket } = await liveClient({ clock });
    clock.advance(60_000);
    expect(heartbeatSocket.closeCalls).toContainEqual({ code: 4000, reason: "heartbeat timeout" });

    const recoverySocket = new TestSocket();
    const recoveryClient = new V3SyncClient({
      url: "ws://sync.test/v3/sync",
      token: async () => "token",
      webSocket: { connect: () => recoverySocket },
    });
    await recoveryClient.start();
    recoverySocket.receive({ type: "unknown" });
    await settle();
    expect(recoverySocket.closeCalls).toContainEqual({ code: 4000, reason: "invalid_frame" });

    let lifecycle: ((event: "online" | "offline" | "active" | "inactive") => void) | undefined;
    const lifecycleSocket = new TestSocket();
    const lifecycleClient = new V3SyncClient({
      url: "ws://sync.test/v3/sync",
      token: async () => "token",
      lifecycle: {
        subscribe: (listener) => {
          lifecycle = listener;
          return () => undefined;
        },
      },
      webSocket: { connect: () => lifecycleSocket },
    });
    await lifecycleClient.start();
    lifecycle?.("inactive");
    expect(lifecycleSocket.closeCalls).toContainEqual({ code: 4000, reason: "lifecycle unavailable" });
  });

  it("gates live traffic on control, media, and presence recovery and declares all four streams", async () => {
    const { client, socket } = await liveClient();
    const hello = socket.frames()[0];
    expect(hello).toMatchObject({ type: "hello", protocol: 3, streams: { control: { cursor: null }, media: { cursor: null }, presence: { cursor: null }, requests: { cursor: null } } });
    expect(client.getSnapshot().connection.phase).toBe("live");
  });

  it("encodes every approved target and operation with stable IDs", async () => {
    const { client, socket } = await liveClient();
    let index = 0;
    void client.setHandRaised(true, { commandId: commandIds[index++] });
    void client.setDisplayName("Renamed", { commandId: commandIds[index++] });
    void client.setAdmissionPolicy("approval", { commandId: commandIds[index++] });
    void client.setParticipantRole(peerId, "cohost", { commandId: commandIds[index++] });
    void client.transferHost(peerId, { commandId: commandIds[index++] });
    void client.admit(recoveryId, { commandId: commandIds[index++] });
    void client.deny(recoveryId, { commandId: commandIds[index++] });
    void client.muteParticipant(peerId, { commandId: commandIds[index++] });
    void client.stopParticipantCamera(peerId, { commandId: commandIds[index++] });
    void client.stopParticipantScreenShare(peerId, { commandId: commandIds[index++] });
    void client.removeParticipant(peerId, { commandId: commandIds[index++] });
    void client.startRecording({ commandId: commandIds[index++], recordingId: recoveryId });
    void client.stopRecording(recoveryId, { commandId: commandIds[index++] });
    void client.leave({ commandId: commandIds[index++] });
    void client.endSession({ commandId: commandIds[index++] });
    await settle();

    expect(
      socket
        .frames()
        .slice(-15)
        .map((frame) => frame.name)
        .sort(),
    ).toEqual(
      [
        "set_hand_raised",
        "set_display_name",
        "set_admission_policy",
        "set_participant_role",
        "transfer_host",
        "admit_participant",
        "deny_admission",
        "mute_participant",
        "stop_participant_camera",
        "stop_participant_screen_share",
        "remove_participant",
        "start_recording",
        "stop_recording",
        "participant_leave",
        "end_session",
      ].sort(),
    );
    expect("setParticipantMediaEnabled" in client).toBe(false);
  });

  it("treats satisfied and duplicate satisfied ACKs as terminal success without an event", async () => {
    const { client, socket, state } = await liveClient();
    const promise = client.setHandRaised(false, { commandId: commandIds[0] });
    await settle();
    socket.receive({ type: "ack", command_id: commandIds[0], delivery: "original", outcome: "satisfied", revision: state.revision, state_digest: state.stateDigest });
    await expect(promise).resolves.toMatchObject({ outcome: "satisfied", delivery: "original" });
    expect(client.getSnapshot().pendingCommandCount).toBe(0);
    socket.receive({ type: "ack", command_id: commandIds[0], delivery: "duplicate", outcome: "satisfied", revision: state.revision, state_digest: state.stateDigest });
    await settle();
    expect(client.getSnapshot().control?.revision).toBe(state.revision);
  });

  it("settles a durable command and retries cleanup when pending-target removal fails", async () => {
    const clock = new TestClock();
    const store = new FailOnceRemoveStore();
    const { client, socket, state } = await liveClient({ clock, pendingStore: store });
    const result = client.setHandRaised(false, { commandId: commandIds[0] });
    await settle();

    socket.receive({ type: "ack", command_id: commandIds[0], delivery: "original", outcome: "satisfied", revision: state.revision, state_digest: state.stateDigest });
    await expect(result).resolves.toMatchObject({ outcome: "satisfied" });

    expect(client.getSnapshot().pendingCommandCount).toBe(0);
    expect(store.removeAttempts).toBe(1);
    expect(socket.frames().filter((frame) => frame.type === "command" && frame.command_id === commandIds[0])).toHaveLength(1);
    expect(await store.load()).toHaveLength(1);

    clock.advance(100);
    await settle();
    expect(store.removeAttempts).toBe(2);
    expect(await store.load()).toHaveLength(0);
    expect(socket.frames().filter((frame) => frame.type === "command" && frame.command_id === commandIds[0])).toHaveLength(1);
    client.stop();
  });

  it("settles an ACK before blocking cleanup and never replays its row across restart", async () => {
    const store = new BlockingRemoveStore();
    const { client, socket, state } = await liveClient({ pendingStore: store });
    const result = client.setHandRaised(false, { commandId: commandIds[0] });
    await settle();

    socket.receive({ type: "ack", command_id: commandIds[0], delivery: "original", outcome: "satisfied", revision: state.revision, state_digest: state.stateDigest });
    await expect(result).resolves.toMatchObject({ outcome: "satisfied" });
    expect(store.removeAttempts).toBe(1);

    client.stop();
    await client.start();
    expect(store.removeAttempts).toBe(2);
    socket.open();
    await settle();
    await recoverSocket(client, socket, state, await wireSnapshot(state), "up_to_date");
    expect(socket.frames().filter((frame) => frame.type === "command" && frame.command_id === commandIds[0])).toHaveLength(1);

    store.completeRemovals();
    await settle();
    expect(await store.load()).toHaveLength(0);
    client.stop();
  });

  it("releases a cleanup-only ID when an ambiguous removal already deleted its row", async () => {
    const clock = new TestClock();
    const store = new DeleteThenRejectStore();
    const { client, socket, state } = await liveClient({ clock, pendingStore: store });
    const result = client.setHandRaised(false, { commandId: commandIds[0] });
    await settle();
    socket.receive({ type: "ack", command_id: commandIds[0], delivery: "original", outcome: "satisfied", revision: state.revision, state_digest: state.stateDigest });
    await expect(result).resolves.toMatchObject({ outcome: "satisfied" });
    await settle();
    expect(await store.load()).toHaveLength(0);

    client.stop();
    await client.start();
    const replacement = client.setHandRaised(true, { commandId: commandIds[0] });
    await settle();
    expect(await store.load()).toHaveLength(1);
    client.stop();
    await expect(replacement).rejects.toMatchObject({ code: "client_stopped" });
  });

  it("counts cleanup-only rows and bytes against pending capacity", async () => {
    const rowStore = new AlwaysFailRemoveStore();
    const rowLimited = await liveClient({ pendingStore: rowStore, maxPendingCommands: 1 });
    const firstRow = rowLimited.client.setHandRaised(false, { commandId: commandIds[0] });
    await settle();
    rowLimited.socket.receive({ type: "ack", command_id: commandIds[0], delivery: "original", outcome: "satisfied", revision: rowLimited.state.revision, state_digest: rowLimited.state.stateDigest });
    await expect(firstRow).resolves.toMatchObject({ outcome: "satisfied" });
    await expect(rowLimited.client.setHandRaised(true, { commandId: commandIds[1] })).rejects.toMatchObject({ code: "capacity" });
    rowLimited.client.stop();

    const byteStore = new AlwaysFailRemoveStore();
    const byteLimited = await liveClient({ pendingStore: byteStore, maxPendingCommands: 10, maxPendingBytes: 200 });
    const firstBytes = byteLimited.client.setHandRaised(false, { commandId: commandIds[0] });
    await settle();
    byteLimited.socket.receive({ type: "ack", command_id: commandIds[0], delivery: "original", outcome: "satisfied", revision: byteLimited.state.revision, state_digest: byteLimited.state.stateDigest });
    await expect(firstBytes).resolves.toMatchObject({ outcome: "satisfied" });
    await expect(byteLimited.client.setHandRaised(true, { commandId: commandIds[1] })).rejects.toMatchObject({ code: "capacity" });
    byteLimited.client.stop();
  });

  it("accepts only exact projection duplicates and recovers on a conflicting duplicate", async () => {
    const { client, socket } = await liveClient();
    const exact = { type: "projection_event", stream: "presence", projection_id: projectionId, sequence: 1, item: { participant_session_id: hostId, state: "connected", speaking: true, active_speaker: true } } as const;
    const exactApplied = snapshotWhen(client, (snapshot) => snapshot.presence?.sequence === 1);
    socket.receive(exact);
    await exactApplied;
    socket.receive(exact);
    expect(client.getSnapshot().presence).toMatchObject({ sequence: 1, items: [{ speaking: true }] });
    const recovering = snapshotWhen(client, (snapshot) => snapshot.connection.phase === "connecting");
    socket.receive({ type: "projection_event", stream: "presence", projection_id: projectionId, sequence: 1, item: { participant_session_id: hostId, state: "connected", speaking: false, active_speaker: false } });
    await recovering;
    expect(client.getSnapshot().connection.phase).toBe("connecting");
  });

  it("holds an ACK-before-event target until the named control head is proven", async () => {
    const { client, socket, state } = await liveClient();
    const next = { ...state, revision: 2, stateDigest: "0".repeat(64), participants: state.participants.map((participant) => ({ ...participant, handRaised: true })) };
    const digest = await computeV3StateDigest(next);
    const promise = client.setHandRaised(true, { commandId: commandIds[0] });
    await settle();
    expect(client.getSnapshot()).toMatchObject({ control: { participants: [{ handRaised: false }] }, optimisticControl: { participants: [{ handRaised: true }] } });
    socket.receive({ type: "ack", command_id: commandIds[0], delivery: "original", outcome: "committed", event_id: recoveryId, revision: 2, state_digest: digest });
    await settle();
    expect(client.getSnapshot().pendingCommandCount).toBe(1);
    socket.receive({
      type: "event",
      stream: "control",
      name: "hand_raised",
      event_id: recoveryId,
      base_revision: 1,
      revision: 2,
      schema_version: 3,
      resulting_state_digest: digest,
      payload: { participant_session_id: hostId },
      command_id: commandIds[0],
    });
    await expect(promise).resolves.toMatchObject({ outcome: "committed" });
    expect(client.getSnapshot().pendingCommandCount).toBe(0);
  });

  it("retains exact control-event evidence and recovers on conflicting duplicates", async () => {
    for (let repetition = 0; repetition < 200; repetition += 1) await exerciseConflictingControlEvidence();
  });

  it("recovers from an unprovable duplicate at a snapshot head", async () => {
    const { client, socket, state } = await liveClient();
    const recovering = snapshotWhen(client, (snapshot) => snapshot.connection.phase === "connecting");
    socket.receive({
      type: "event",
      stream: "control",
      name: "hand_lowered",
      event_id: recoveryId,
      base_revision: 0,
      revision: 1,
      schema_version: 3,
      resulting_state_digest: state.stateDigest,
      payload: { participant_session_id: hostId },
      command_id: commandIds[0],
    });
    await recovering;
    expect(client.getSnapshot().connection.phase).toBe("connecting");
  });

  it("sends self media as live targets and completes from explicit results", async () => {
    const { client, socket, mediaPlane } = await liveClient();
    const microphone = client.setMicrophoneEnabled(true, { requestId: commandIds[0] });
    const camera = client.setCameraEnabled(false, { requestId: commandIds[1] });
    const screen = client.setScreenShareEnabled(true, { requestId: commandIds[2] });
    expect(
      socket
        .frames()
        .slice(-3)
        .map((frame) => frame.name),
    ).toEqual(["set_microphone_enabled", "set_camera_enabled", "set_screen_share_enabled"]);
    expect(mediaPlane.targets).toEqual([]);
    socket.receive({ type: "live_target_result", operation_id: commandIds[0], name: "set_microphone_enabled", outcome: "confirmed", error_code: null });
    socket.receive({ type: "live_target_result", operation_id: commandIds[1], name: "set_camera_enabled", outcome: "satisfied", error_code: null });
    socket.receive({ type: "live_target_result", operation_id: commandIds[2], name: "set_screen_share_enabled", outcome: "terminal_failure", error_code: "screen_share_in_use" });
    await expect(microphone).resolves.toMatchObject({ serverOutcome: "confirmed", mediaPlaneOutcome: "confirmed" });
    await expect(camera).resolves.toMatchObject({ serverOutcome: "satisfied", mediaPlaneOutcome: "confirmed" });
    await expect(screen).rejects.toMatchObject({ code: "terminal_failure" });
    expect(mediaPlane.targets).toEqual([
      { operationId: commandIds[0], participantSessionId: hostId, source: "microphone", enabled: true },
      { operationId: commandIds[1], participantSessionId: hostId, source: "camera", enabled: false },
    ]);
  });

  it("requires a MediaPlane adapter before sending a self-media target", async () => {
    const { client, socket } = await liveClient({ mediaPlane: undefined });
    const sentBefore = socket.sent.length;
    await expect(client.setMicrophoneEnabled(true, { requestId: commandIds[0] })).rejects.toMatchObject({ code: "media_plane_unavailable" });
    expect(socket.sent.length).toBe(sentBefore);
  });

  it("retries the local MediaPlane with one operation ID and bounds retry exhaustion", async () => {
    const mediaPlane = new TestMediaPlane();
    mediaPlane.results.push({ outcome: "retryable_failure", errorCode: "device_busy" }, { outcome: "retryable_failure", errorCode: "device_busy" }, { outcome: "retryable_failure", errorCode: "device_busy" }, { outcome: "retryable_failure", errorCode: "device_busy" });
    const { client, socket } = await liveClient({ mediaPlane, retryDelayMs: 0 });
    const result = client.setCameraEnabled(true, { requestId: commandIds[0] });
    socket.receive({ type: "live_target_result", operation_id: commandIds[0], name: "set_camera_enabled", outcome: "confirmed", error_code: null });
    await expect(result).rejects.toMatchObject({ code: "retry_exhausted" });
    expect(mediaPlane.targets).toHaveLength(4);
    expect(new Set(mediaPlane.targets.map((target) => target.operationId))).toEqual(new Set([commandIds[0]]));
  });

  it("fails ambiguous local outcomes and does not execute twice for duplicate server results", async () => {
    const mediaPlane = new TestMediaPlane();
    mediaPlane.results.push({ outcome: "ambiguous", errorCode: "device_result_unknown" });
    const { client, socket } = await liveClient({ mediaPlane });
    const result = client.setScreenShareEnabled(true, { requestId: commandIds[0] });
    const serverResult = { type: "live_target_result", operation_id: commandIds[0], name: "set_screen_share_enabled", outcome: "satisfied", error_code: null } as const;
    socket.receive(serverResult);
    socket.receive(serverResult);
    await expect(result).rejects.toMatchObject({ code: "ambiguous" });
    expect(mediaPlane.targets).toHaveLength(1);
  });

  it("rejects local terminal failure and bounds server live-target retries before touching the adapter", async () => {
    const terminalMediaPlane = new TestMediaPlane();
    terminalMediaPlane.results.push({ outcome: "terminal_failure", errorCode: "permission_denied" });
    const terminal = await liveClient({ mediaPlane: terminalMediaPlane });
    const terminalResult = terminal.client.setMicrophoneEnabled(true, { requestId: commandIds[0] });
    terminal.socket.receive({ type: "live_target_result", operation_id: commandIds[0], name: "set_microphone_enabled", outcome: "confirmed", error_code: null });
    await expect(terminalResult).rejects.toMatchObject({ code: "terminal_failure" });

    const retryMediaPlane = new TestMediaPlane();
    const retry = await liveClient({ mediaPlane: retryMediaPlane, retryDelayMs: 0 });
    const retryResult = retry.client.setCameraEnabled(true, { requestId: commandIds[1] });
    const retryRejected = expect(retryResult).rejects.toMatchObject({ code: "retry_exhausted" });
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      retry.socket.receive({ type: "live_target_result", operation_id: commandIds[1], name: "set_camera_enabled", outcome: "retryable_failure", error_code: "lease_pending" });
      await settle();
    }
    await retryRejected;
    expect(retryMediaPlane.targets).toEqual([]);
  });

  it("projects bounded local and remote MediaPlane observations without a remote control surface", async () => {
    const { client, mediaPlane } = await liveClient();
    mediaPlane.emitLocal([{ participantSessionId: hostId, source: "microphone", enabled: true, publicationId: "local-microphone" }]);
    mediaPlane.emitRemote([{ participantSessionId: peerId, source: "camera", enabled: true, publicationId: "remote-camera" }]);
    expect(client.getSnapshot()).toMatchObject({
      localMedia: { microphone: "enabled" },
      mediaPlane: { local: [{ publicationId: "local-microphone" }], remote: [{ publicationId: "remote-camera" }] },
    });
    expect("setRemotePublicationTarget" in mediaPlane).toBe(false);
    client.stop();
    mediaPlane.emitLocal([]);
    expect(client.getSnapshot().mediaPlane.local).toEqual([]);
  });

  it("rejects an in-flight local target on stop and never replays it after process restart", async () => {
    const mediaPlane = new BlockingMediaPlane();
    const { client, socket } = await liveClient({ mediaPlane });
    const target = client.setMicrophoneEnabled(true, { requestId: commandIds[0] });
    const rejected = expect(target).rejects.toMatchObject({ code: "client_stopped" });
    socket.receive({ type: "live_target_result", operation_id: commandIds[0], name: "set_microphone_enabled", outcome: "confirmed", error_code: null });
    await settle();
    expect(mediaPlane.targets).toHaveLength(1);
    client.stop();
    await rejected;
    mediaPlane.complete({ outcome: "confirmed", errorCode: null });
    await settle();

    const restarted = await liveClient({ mediaPlane });
    expect(restarted.socket.frames().some((frame) => frame.type === "live_target")).toBe(false);
    expect(mediaPlane.targets).toHaveLength(1);
    restarted.client.stop();
  });

  it("uses request/deliver/ack/result frames and never queues requests while disconnected", async () => {
    const { client, socket } = await liveClient();
    const result = client.requestUnmute(peerId, { requestId: commandIds[0] });
    expect(socket.frames().at(-1)).toMatchObject({ type: "directed_request", name: "request_unmute", target_participant_session_id: peerId });
    socket.receive({ type: "directed_request_result", request_id: commandIds[0], result: "delivered" });
    await expect(result).resolves.toMatchObject({ result: "delivered" });

    let delivered = "";
    client.onDirectedRequest((request) => (delivered = request.name));
    socket.receive({ type: "directed_request", request_id: commandIds[1], name: "request_start_camera", actor_participant_session_id: peerId, expires_at_ms: Date.now() + 30_000 });
    await settle();
    expect(delivered).toBe("request_start_camera");
    expect(socket.frames().at(-1)).toEqual({ type: "request_ack", request_id: commandIds[1] });
    const sentBeforeExpiry = socket.sent.length;
    socket.receive({ type: "directed_request", request_id: commandIds[2], name: "request_unmute", actor_participant_session_id: peerId, expires_at_ms: 1 });
    await settle();
    expect(socket.sent.length).toBe(sentBeforeExpiry);
    client.stop();
    await expect(client.requestStartCamera(peerId)).rejects.toMatchObject({ code: "not_live" });
  });

  it("rejects duplicate live-target and directed-request IDs before replacing their Promises", async () => {
    const { client } = await liveClient();
    void client.setMicrophoneEnabled(true, { requestId: commandIds[0] }).catch(() => undefined);
    expect(() => client.setCameraEnabled(true, { requestId: commandIds[0] })).toThrowError(/request ID is already pending/u);
    void client.requestUnmute(peerId, { requestId: commandIds[1] }).catch(() => undefined);
    expect(() => client.requestStartCamera(peerId, { requestId: commandIds[1] })).toThrowError(/request ID is already pending/u);
    client.stop();
  });

  it("rejects transient retry exhaustion while preserving durable targets", async () => {
    const { client, socket } = await liveClient({ retryDelayMs: 0 });
    const target = client.setAdmissionPolicy("approval", { commandId: commandIds[0] });
    const targetRejected = expect(target).rejects.toMatchObject({ code: "retry_exhausted" });
    await settle();
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      socket.receive({ type: "retryable_error", command_id: commandIds[0], code: "overloaded" });
      await settle();
    }
    await targetRejected;
    expect(client.getSnapshot().pendingCommandCount).toBe(1);

    const exhaustedOperation = client.stopParticipantCamera(peerId, { commandId: commandIds[2] });
    const operationRejected = expect(exhaustedOperation).rejects.toMatchObject({ code: "retry_exhausted" });
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      socket.receive({ type: "retryable_error", command_id: commandIds[2], code: "dependency_unavailable" });
      await settle();
    }
    await operationRejected;
    client.stop();
  });

  it("polls repeated external-operation pending responses until a terminal ACK", async () => {
    const clock = new TestClock();
    const { client, socket } = await liveClient({ clock, maxOperationPendingAgeMs: 10_000 });
    const operation = client.muteParticipant(peerId, { commandId: commandIds[0] });
    const rejected = expect(operation).rejects.toMatchObject({ code: "rejected" });
    await settle();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      socket.receive({ type: "retryable_error", command_id: commandIds[0], code: "external_operation_pending" });
      await settle();
      clock.advance(1_000);
      expect(operationFrames(socket, commandIds[0])).toHaveLength(attempt + 2);
    }

    socket.receive({ type: "ack", command_id: commandIds[0], delivery: "original", outcome: "rejected", reason: "external_operation_failed" });
    await rejected;
    clock.advance(10_000);
    expect(operationFrames(socket, commandIds[0])).toHaveLength(5);
  });

  it("deduplicates the pending-operation timer for duplicate status responses", async () => {
    const clock = new TestClock();
    const { client, socket } = await liveClient({ clock, maxOperationPendingAgeMs: 10_000 });
    void client.stopParticipantCamera(peerId, { commandId: commandIds[0] }).catch(() => undefined);
    await settle();

    for (let duplicate = 0; duplicate < 3; duplicate += 1) {
      socket.receive({ type: "retryable_error", command_id: commandIds[0], code: "external_operation_pending" });
    }
    await settle();
    clock.advance(999);
    expect(operationFrames(socket, commandIds[0])).toHaveLength(1);
    clock.advance(1);
    expect(operationFrames(socket, commandIds[0])).toHaveLength(2);
    clock.advance(5_000);
    expect(operationFrames(socket, commandIds[0])).toHaveLength(2);
    client.stop();
  });

  it("keeps a role target pending after its event and settles it only from the proven ACK", async () => {
    const clock = new TestClock();
    const store = new InMemoryV3PendingTargetStore();
    const initial = stateWithPeer("cohost");
    const { client, socket } = await liveClient({ clock, pendingStore: store, maxOperationPendingAgeMs: 10_000 }, initial);
    const operation = client.setParticipantRole(peerId, "participant", { commandId: commandIds[0] });
    await settle();
    socket.receive({ type: "retryable_error", command_id: commandIds[0], code: "external_operation_pending" });
    await settle();

    const next = {
      ...initial,
      revision: 2,
      stateDigest: "0".repeat(64),
      participants: initial.participants.map((participant) => (participant.participantSessionId === peerId ? { ...participant, role: "participant" as const, capabilities: [...initial.roleCapabilities.participant] } : participant)),
    };
    const digest = await computeV3StateDigest(next);
    const event = {
      type: "event",
      stream: "control",
      name: "participant_role_changed",
      event_id: recoveryId,
      base_revision: 1,
      revision: 2,
      schema_version: 3,
      resulting_state_digest: digest,
      payload: { participant_session_id: peerId, role: "participant" },
      command_id: commandIds[0],
    } as const;
    const eventApplied = snapshotWhen(client, (snapshot) => snapshot.control?.revision === 2);
    socket.receive(event);
    await eventApplied;
    expect(client.getSnapshot()).toMatchObject({ control: { participants: [{ role: "host" }, { role: "participant" }] }, pendingCommandCount: 1 });
    expect(await store.load()).toHaveLength(1);

    socket.receive({ type: "ack", command_id: commandIds[0], delivery: "original", outcome: "committed", event_id: recoveryId, revision: 2, state_digest: digest });
    await expect(operation).resolves.toMatchObject({ outcome: "committed" });
    expect(await store.load()).toHaveLength(0);
    socket.receive(event);
    await settle();
    expect(client.getSnapshot()).toMatchObject({ connection: { phase: "live" }, pendingCommandCount: 0 });
    clock.advance(10_000);
    expect(operationFrames(socket, commandIds[0])).toHaveLength(1);
  });

  it("clears pending polls on disconnect and resumes once after recovery", async () => {
    const clock = new TestClock();
    const sockets: TestSocket[] = [];
    const client = new V3SyncClient({
      url: "ws://sync.test/v3/sync",
      token: async () => "token",
      clock,
      reconnectDelayMs: 0,
      maxOperationPendingAgeMs: 10_000,
      webSocket: {
        connect: () => {
          const socket = new TestSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    const snapshot = await wireSnapshot(baseState());
    const state = snapshotToState(snapshot);
    await client.start();
    sockets[0]!.open();
    await settle();
    await recoverSocket(client, sockets[0]!, state, snapshot, "snapshot");
    const operation = client.removeParticipant(peerId, { commandId: commandIds[0] });
    const rejected = expect(operation).rejects.toMatchObject({ code: "rejected" });
    sockets[0]!.receive({ type: "retryable_error", command_id: commandIds[0], code: "external_operation_pending" });
    await settle();
    sockets[0]!.close(1012);
    clock.advance(0);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    await settle();
    await recoverSocket(client, sockets[1]!, state, snapshot, "up_to_date");
    expect(operationFrames(sockets[1]!, commandIds[0])).toHaveLength(1);
    clock.advance(1_000);
    expect(operationFrames(sockets[1]!, commandIds[0])).toHaveLength(1);

    sockets[1]!.receive({ type: "retryable_error", command_id: commandIds[0], code: "external_operation_pending" });
    await settle();
    clock.advance(1_000);
    expect(operationFrames(sockets[1]!, commandIds[0])).toHaveLength(2);
    sockets[1]!.receive({ type: "ack", command_id: commandIds[0], delivery: "duplicate", outcome: "rejected", reason: "external_operation_failed" });
    await rejected;
    clock.advance(10_000);
    expect(operationFrames(sockets[1]!, commandIds[0])).toHaveLength(2);
  });

  it("does not persist external-operation frames across a full client restart", async () => {
    const store = new InMemoryV3PendingTargetStore();
    const first = await liveClient({ pendingStore: store });
    void first.client.muteParticipant(peerId, { commandId: commandIds[0] }).catch(() => undefined);
    await settle();
    first.client.stop();
    expect(await store.load()).toHaveLength(0);

    const restarted = await liveClient({ pendingStore: store });
    expect(operationFrames(restarted.socket, commandIds[0])).toHaveLength(0);
    restarted.client.stop();
  });

  it("rejects and removes a command when its maximum pending-operation age is exhausted", async () => {
    const clock = new TestClock();
    const { client, socket } = await liveClient({ clock, maxOperationPendingAgeMs: 2_500, maxPendingCommands: 1 });
    const operation = client.endSession({ commandId: commandIds[0] });
    const rejected = expect(operation).rejects.toMatchObject({ code: "operation_pending_timeout" });
    socket.receive({ type: "retryable_error", command_id: commandIds[0], code: "external_operation_pending" });
    await settle();
    clock.advance(1_000);
    socket.receive({ type: "retryable_error", command_id: commandIds[0], code: "external_operation_pending" });
    await settle();
    clock.advance(1_000);
    socket.receive({ type: "retryable_error", command_id: commandIds[0], code: "external_operation_pending" });
    await settle();
    clock.advance(499);
    expect(operationFrames(socket, commandIds[0])).toHaveLength(3);
    clock.advance(1);
    await rejected;
    clock.advance(10_000);
    expect(operationFrames(socket, commandIds[0])).toHaveLength(3);
    void client.leave({ commandId: commandIds[1] }).catch(() => undefined);
    expect(operationFrames(socket, commandIds[1])).toHaveLength(1);
    client.stop();
  });

  it("retries durable cleanup after a pending target operation reaches its maximum age", async () => {
    const clock = new TestClock();
    const store = new FailOnceRemoveStore();
    const { client, socket } = await liveClient({ clock, pendingStore: store, maxOperationPendingAgeMs: 10, retryDelayMs: 100 });
    const operation = client.setParticipantRole(peerId, "cohost", { commandId: commandIds[0] });
    const rejected = expect(operation).rejects.toMatchObject({ code: "operation_pending_timeout" });
    await settle();

    socket.receive({ type: "retryable_error", command_id: commandIds[0], code: "external_operation_pending" });
    await settle();
    clock.advance(10);
    await rejected;

    expect(store.removeAttempts).toBe(1);
    expect(await store.load()).toHaveLength(1);
    expect(operationFrames(socket, commandIds[0])).toHaveLength(1);

    clock.advance(100);
    await settle();
    expect(store.removeAttempts).toBe(2);
    expect(await store.load()).toHaveLength(0);
    expect(operationFrames(socket, commandIds[0])).toHaveLength(1);
    client.stop();
  });

  it("bounds in-flight work", async () => {
    const { client } = await liveClient({ maxPendingCommands: 1 });
    void client.setCameraEnabled(true, { requestId: commandIds[0] });
    expect(() => client.setScreenShareEnabled(true, { requestId: commandIds[1] })).toThrow(V3SyncError);
  });

  it("restores durable targets from the v3 persistence namespace after process restart", async () => {
    const store = new InMemoryV3PendingTargetStore();
    const first = new V3SyncClient({ url: "ws://sync.test/v3/sync", token: async () => "token", webSocket: { connect: () => new TestSocket() }, pendingStore: store });
    void first.setDisplayName("Persisted", { commandId: commandIds[0] }).catch(() => undefined);
    await settle();
    first.stop();

    const { socket } = await liveClient({ pendingStore: store });
    expect(socket.frames().at(-1)).toMatchObject({ type: "command", command_id: commandIds[0], name: "set_display_name", payload: { display_name: "Persisted" } });
  });

  it("retries failed cleanup for an expired restored target without replaying it", async () => {
    const clock = new TestClock();
    clock.advance(100);
    const pending: V3PendingTarget = { commandId: commandIds[0], command: { name: "set_hand_raised", payload: { raised: true } }, createdAt: 0, bytes: 100 };
    const store = new FailOnceRemoveStore([pending]);
    const { client, socket } = await liveClient({ clock, pendingStore: store, maxPendingAgeMs: 10 });

    expect(store.removeAttempts).toBe(1);
    expect(socket.frames().filter((frame) => frame.type === "command" && frame.command_id === commandIds[0])).toHaveLength(0);
    expect(await store.load()).toHaveLength(1);

    clock.advance(100);
    await settle();
    expect(store.removeAttempts).toBe(2);
    expect(await store.load()).toHaveLength(0);
    expect(socket.frames().filter((frame) => frame.type === "command" && frame.command_id === commandIds[0])).toHaveLength(0);
    client.stop();
  });

  it("reconnects with the exact control cursor, retries safe commands, and drops directed requests", async () => {
    const sockets: TestSocket[] = [];
    const client = new V3SyncClient({
      url: "ws://sync.test/v3/sync",
      token: async () => "token",
      reconnectDelayMs: 0,
      webSocket: {
        connect: () => {
          const socket = new TestSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    const snapshot = await wireSnapshot(baseState());
    const state = snapshotToState(snapshot);
    await client.start();
    sockets[0]!.open();
    await settle();
    await recoverSocket(client, sockets[0]!, state, snapshot, "snapshot");

    void client.setAdmissionPolicy("approval", { commandId: commandIds[0] }).catch(() => undefined);
    const request = client.requestStartCamera(peerId, { requestId: commandIds[1] });
    sockets[0]!.close(1012);
    await expect(request).rejects.toMatchObject({ code: "disconnected_before_delivery" });
    for (let attempt = 0; attempt < 20 && sockets.length < 2; attempt += 1) await settle();
    sockets[1]!.open();
    await settle();
    expect(sockets[1]!.frames()[0]).toMatchObject({ streams: { control: { cursor: { revision: 1, state_schema_version: 3, state_digest: state.stateDigest } } } });
    await recoverSocket(client, sockets[1]!, state, snapshot, "up_to_date");
    expect(sockets[1]!.frames().at(-1)).toMatchObject({ type: "command", command_id: commandIds[0], name: "set_admission_policy" });
    expect(sockets[1]!.frames().some((frame) => frame.type === "directed_request")).toBe(false);
    client.stop();
  });

  it("persists v3 targets in an isolated React Native namespace and fails closed without IndexedDB", async () => {
    const storage = new TestAsyncStorage();
    const store = new AsyncStorageV3PendingTargetStore({ scope: "session", storage });
    const pending = { commandId: commandIds[0], command: { name: "set_hand_raised" as const, payload: { raised: true } }, createdAt: 1, bytes: 100 };
    await store.put(pending);
    expect((await new AsyncStorageV3PendingTargetStore({ scope: "session", storage }).load())[0]).toEqual(pending);
    expect([...storage.values.keys()]).toEqual(["chalk-sync-v3:pending-targets:session"]);
    await expect(new IndexedDbV3PendingTargetStore({ scope: "session", indexedDb: undefined }).load()).rejects.toThrow("IndexedDB is unavailable");
  });
});

describe("v3 exact decoding and durable state", () => {
  it("rejects unknown frame fields", () => {
    expect(() => decodeV3ServerFrame(JSON.stringify({ type: "pong", extra: true }))).toThrow();
  });

  it("derives capabilities from the role map and rejects inconsistent redundant capabilities or nullable host", async () => {
    const snapshot = await wireSnapshot(baseState());
    const restored = await restoreV3Snapshot(snapshot);
    expect(restored.participants[0]?.capabilities).toEqual(restored.roleCapabilities.host);

    snapshot.participants[0]!.capabilities = [];
    await expect(restoreV3Snapshot(snapshot)).rejects.toBeInstanceOf(V3ReplicaError);

    const invalid = { ...snapshot, status: "ended" as const, host_participant_session_id: null, participants: [] };
    await expect(restoreV3Snapshot(invalid)).rejects.toBeInstanceOf(V3ReplicaError);
  });

  it("derives first-host authority from the first host admission event", async () => {
    const empty: V3ControlState = {
      ...baseState(),
      revision: 0,
      hostParticipantSessionId: null,
      participants: [],
    };
    const expected: V3ControlState = {
      ...empty,
      revision: 1,
      hostParticipantSessionId: hostId,
      participants: [{ participantSessionId: hostId, displayName: "Host", handRaised: false, admissionRevision: 1, role: "host", eligibleRoles: ["host", "cohost"], capabilities: [...empty.roleCapabilities.host] }],
    };
    const resultingStateDigest = await computeV3StateDigest(expected);
    const reduced = await applyV3Event(empty, {
      type: "event",
      stream: "control",
      name: "participant_joined",
      event_id: recoveryId,
      base_revision: 0,
      revision: 1,
      schema_version: 3,
      resulting_state_digest: resultingStateDigest,
      payload: { participant_session_id: hostId, display_name: "Host", role: "host", eligible_roles: ["host", "cohost"], admission_revision: 1 },
      lifecycle_intent_id: projectionId,
    });
    expect(reduced).toMatchObject({ hostParticipantSessionId: hostId, participants: [{ role: "host" }] });
  });

  it("rejects noncanonical display names and an ineligible pending host envelope", async () => {
    const spacedParticipant = await wireSnapshot(baseState());
    spacedParticipant.participants[0]!.display_name = " Host ";
    await expect(restoreV3Snapshot(spacedParticipant)).rejects.toBeInstanceOf(V3ReplicaError);

    const pendingHost = await wireSnapshot(baseState());
    pendingHost.admission_requests = [
      {
        admission_request_id: recoveryId,
        participant_session_id: peerId,
        display_name: "Pending host",
        initial_role: "host",
        eligible_roles: ["host"],
        expires_at_ms: 120_000,
      },
    ];
    await expect(restoreV3Snapshot(pendingHost)).rejects.toBeInstanceOf(V3ReplicaError);
  });

  it("applies tenant deadline facts without exposing a participant deadline command", async () => {
    const snapshot = await wireSnapshot(baseState());
    const state = snapshotToState(snapshot);
    const next = { ...state, revision: 2, stateDigest: "0".repeat(64), deadlineAtMs: 120_000, deadlineGeneration: 2 };
    const digest = await computeV3StateDigest(next);
    const reduced = await applyV3Event(state, {
      type: "event",
      stream: "control",
      name: "deadline_changed",
      event_id: recoveryId,
      base_revision: 1,
      revision: 2,
      schema_version: 3,
      resulting_state_digest: digest,
      payload: { deadline_at_ms: 120_000, deadline_generation: 2 },
      external_operation_id: projectionId,
    });
    expect(reduced).toMatchObject({ deadlineAtMs: 120_000, deadlineGeneration: 2 });
    const client = new V3SyncClient({ url: "ws://sync.test/v3/sync", token: async () => "token", webSocket: { connect: () => new TestSocket() } });
    expect("setDeadline" in client).toBe(false);
  });

  it("removes an expired admission request from durable control", async () => {
    const snapshot = await wireSnapshot(baseState());
    const initial = snapshotToState(snapshot);
    const rawState: V3ControlState = {
      ...initial,
      admissionRequests: [{ admissionRequestId: recoveryId, participantSessionId: peerId, displayName: "Pending", initialRole: "participant", eligibleRoles: ["participant"], expiresAtMs: 120_000 }],
    };
    const state = { ...rawState, stateDigest: await computeV3StateDigest(rawState) };
    const next = { ...state, revision: 2, stateDigest: "0".repeat(64), admissionRequests: [] };
    const digest = await computeV3StateDigest(next);
    const reduced = await applyV3Event(state, {
      type: "event",
      stream: "control",
      name: "admission_expired",
      event_id: recoveryId,
      base_revision: 1,
      revision: 2,
      schema_version: 3,
      resulting_state_digest: digest,
      payload: { admission_request_id: recoveryId },
      external_operation_id: projectionId,
    });
    expect(reduced.admissionRequests).toEqual([]);
  });

  it("rejects unknown admission/moderation targets and skipped deadline generations", async () => {
    const state = snapshotToState(await wireSnapshot(baseState()));
    await expect(
      applyV3Event(state, {
        ...eventBase("admission_denied"),
        payload: { admission_request_id: recoveryId },
        external_operation_id: projectionId,
      }),
    ).rejects.toThrow(/unknown admission request/u);
    await expect(
      applyV3Event(state, {
        ...eventBase("admission_expired"),
        payload: { admission_request_id: recoveryId },
        external_operation_id: projectionId,
      }),
    ).rejects.toThrow(/unknown admission request/u);
    await expect(
      applyV3Event(state, {
        ...eventBase("participant_microphone_stopped"),
        payload: { participant_session_id: peerId },
        external_operation_id: projectionId,
      }),
    ).rejects.toThrow(/unknown participant/u);
    await expect(
      applyV3Event(state, {
        ...eventBase("deadline_changed"),
        payload: { deadline_at_ms: 120_000, deadline_generation: 3 },
        external_operation_id: projectionId,
      }),
    ).rejects.toThrow(/generation is not exact-next/u);
  });

  it("enforces keyed Recording transitions and rejects illegal jumps", async () => {
    const initial = snapshotToState(await wireSnapshot(baseState()));
    await expect(
      applyV3Event(initial, {
        ...eventBase("recording_status_changed"),
        payload: { recording_id: recoveryId, status: "recording", failure_code: null },
        external_operation_id: projectionId,
      }),
    ).rejects.toThrow(/changed identity/u);

    const startingProjection = { ...initial, revision: 2, stateDigest: "0".repeat(64), recording: { recordingId: recoveryId, status: "starting" as const, failureCode: null } };
    const startingDigest = await computeV3StateDigest(startingProjection);
    const starting = await applyV3Event(initial, {
      ...eventBase("recording_status_changed"),
      resulting_state_digest: startingDigest,
      payload: { recording_id: recoveryId, status: "starting", failure_code: null },
      external_operation_id: projectionId,
    });
    await expect(
      applyV3Event(starting, {
        ...eventBase("recording_status_changed", 2, 3),
        payload: { recording_id: recoveryId, status: "stopping", failure_code: null },
        external_operation_id: projectionId,
      }),
    ).rejects.toThrow(/illegal Recording status transition/u);
    await expect(
      applyV3Event(starting, {
        ...eventBase("recording_status_changed", 2, 3),
        payload: { recording_id: peerId, status: "recording", failure_code: null },
        external_operation_id: projectionId,
      }),
    ).rejects.toThrow(/changed identity/u);
  });

  it("rejects malformed durable snapshot invariants before accepting authority", async () => {
    const valid = await wireSnapshot(baseState());
    const request = {
      admission_request_id: recoveryId,
      participant_session_id: hostId,
      display_name: "Pending",
      initial_role: "participant" as const,
      eligible_roles: ["participant"] as const,
      expires_at_ms: 120_000,
    };
    const malformed: Snapshot[] = [
      { ...valid, participants: [...valid.participants, valid.participants[0]!] },
      { ...valid, participants: valid.participants.map((participant) => ({ ...participant, eligible_roles: [] })) },
      { ...valid, participants: valid.participants.map((participant) => ({ ...participant, role: "host" as const, eligible_roles: ["participant"] })) },
      { ...valid, participants: valid.participants.map((participant) => ({ ...participant, eligible_roles: ["host"] })) },
      { ...valid, participants: valid.participants.map((participant) => ({ ...participant, role: "participant" as const, capabilities: valid.role_capabilities.participant })) },
      { ...valid, status: "ended", participants: valid.participants },
      { ...valid, participants: valid.participants.map((participant) => ({ ...participant, capabilities: [] })) },
      { ...valid, admission_requests: [request] },
      { ...valid, recording: { recording_id: recoveryId, status: "failed", failure_code: null } },
      { ...valid, recording: { recording_id: recoveryId, status: "recording", failure_code: "provider_failed" } },
    ];
    for (const snapshot of malformed) await expect(restoreV3Snapshot(snapshot)).rejects.toBeInstanceOf(V3ReplicaError);
  });
});

async function liveClient(overrides: Partial<ConstructorParameters<typeof V3SyncClient>[0]> = {}, initialState = baseState()) {
  const socket = new TestSocket();
  const factory: SyncWebSocketFactory = { connect: () => socket };
  const mediaPlane = new TestMediaPlane();
  const client = new V3SyncClient({ url: "ws://sync.test/v3/sync", token: async () => "token", webSocket: factory, mediaPlane, ...overrides });
  const snapshot = await wireSnapshot(initialState);
  const state = snapshotToState(snapshot);
  await client.start();
  socket.open();
  await settle();
  socket.receive({
    type: "welcome",
    protocol: 3,
    participant_session_id: hostId,
    participant_session_generation: 1,
    recovery_id: recoveryId,
    head: { revision: state.revision, state_schema_version: state.stateSchemaVersion, state_digest: state.stateDigest },
    mode: "snapshot",
    snapshot,
  });
  socket.receive({ type: "projection_snapshot", stream: "media", projection_id: projectionId, sequence: 0, items: [] });
  socket.receive({ type: "projection_snapshot", stream: "presence", projection_id: projectionId, sequence: 0, items: [] });
  socket.receive({ type: "recovery_complete", recovery_id: recoveryId, head: { revision: state.revision, state_schema_version: state.stateSchemaVersion, state_digest: state.stateDigest } });
  for (let attempt = 0; attempt < 50 && client.getSnapshot().connection.phase !== "live"; attempt += 1) await settle();
  expect(client.getSnapshot().connection.phase).toBe("live");
  return { client, socket, state, mediaPlane };
}

async function recoverSocket(client: V3SyncClient, socket: TestSocket, state: V3ControlState, snapshot: Snapshot, mode: "snapshot" | "up_to_date"): Promise<void> {
  socket.receive({
    type: "welcome",
    protocol: 3,
    participant_session_id: hostId,
    participant_session_generation: 1,
    recovery_id: recoveryId,
    head: { revision: state.revision, state_schema_version: state.stateSchemaVersion, state_digest: state.stateDigest },
    mode,
    ...(mode === "snapshot" ? { snapshot } : {}),
  });
  socket.receive({ type: "projection_snapshot", stream: "media", projection_id: projectionId, sequence: 0, items: [] });
  socket.receive({ type: "projection_snapshot", stream: "presence", projection_id: projectionId, sequence: 0, items: [] });
  socket.receive({ type: "recovery_complete", recovery_id: recoveryId, head: { revision: state.revision, state_schema_version: state.stateSchemaVersion, state_digest: state.stateDigest } });
  for (let attempt = 0; attempt < 50 && client.getSnapshot().connection.phase !== "live"; attempt += 1) await settle();
  expect(client.getSnapshot().connection.phase).toBe("live");
}

function eventBase<Name extends "admission_denied" | "admission_expired" | "participant_microphone_stopped" | "deadline_changed" | "recording_status_changed">(name: Name, baseRevision = 1, revision = 2) {
  return {
    type: "event" as const,
    stream: "control" as const,
    name,
    event_id: recoveryId,
    base_revision: baseRevision,
    revision,
    schema_version: 3,
    resulting_state_digest: "a".repeat(64),
  };
}

function baseState(): V3ControlState {
  return {
    revision: 1,
    stateSchemaVersion: 3,
    stateDigest: "0".repeat(64),
    status: "active",
    admissionPolicy: "open",
    hostExitPolicy: "require_transfer",
    hostParticipantSessionId: hostId,
    deadlineAtMs: 99_999,
    deadlineGeneration: 1,
    roleCapabilities: { host: ["publishAudio", "endMeeting"], cohost: ["publishAudio"], participant: ["subscribe"] },
    recording: null,
    participants: [{ participantSessionId: hostId, displayName: "Host", handRaised: false, admissionRevision: 1, role: "host", eligibleRoles: ["host", "cohost"], capabilities: ["publishAudio", "endMeeting"] }],
    admissionRequests: [],
  };
}

function stateWithPeer(role: "cohost" | "participant"): V3ControlState {
  const state = baseState();
  return {
    ...state,
    participants: [
      ...state.participants,
      {
        participantSessionId: peerId,
        displayName: "Peer",
        handRaised: false,
        admissionRevision: 2,
        role,
        eligibleRoles: ["cohost", "participant"],
        capabilities: [...state.roleCapabilities[role]],
      },
    ],
  };
}

async function wireSnapshot(initial: V3ControlState): Promise<Snapshot> {
  const state = { ...initial, stateDigest: await computeV3StateDigest(initial) };
  return {
    control_revision: state.revision,
    state_schema_version: state.stateSchemaVersion,
    state_digest: state.stateDigest,
    status: state.status,
    admission_policy: state.admissionPolicy,
    host_exit_policy: state.hostExitPolicy,
    host_participant_session_id: state.hostParticipantSessionId,
    deadline_at_ms: state.deadlineAtMs,
    deadline_generation: state.deadlineGeneration,
    role_capabilities: state.roleCapabilities,
    recording: null,
    participants: state.participants.map((participant) => ({
      participant_session_id: participant.participantSessionId,
      display_name: participant.displayName,
      hand_raised: participant.handRaised,
      admission_revision: participant.admissionRevision,
      role: participant.role,
      eligible_roles: participant.eligibleRoles,
      capabilities: participant.capabilities,
    })),
    admission_requests: [],
  };
}

class TestSocket implements SyncSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly closeCalls: { readonly code: number; readonly reason: string | undefined }[] = [];
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.onclose?.({ code });
  }

  error(): void {
    this.onerror?.();
  }

  open(): void {
    this.onopen?.();
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map((frame) => JSON.parse(frame));
  }
}

class TestClock {
  #now = 0;
  #nextHandle = 0;
  readonly #timers = new Map<number, { readonly at: number; readonly callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, milliseconds: number): number {
    const handle = this.#nextHandle++;
    this.#timers.set(handle, { at: this.#now + milliseconds, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#timers.delete(handle);
  }

  advance(milliseconds: number): void {
    const target = this.#now + milliseconds;
    while (true) {
      const due = [...this.#timers.entries()].filter(([, timer]) => timer.at <= target).sort(([leftHandle, left], [rightHandle, right]) => left.at - right.at || leftHandle - rightHandle)[0];
      if (!due) break;
      const [handle, timer] = due;
      this.#timers.delete(handle);
      this.#now = timer.at;
      timer.callback();
    }
    this.#now = target;
  }
}

class TestAsyncStorage {
  readonly values = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class FailOnceLoadStore extends InMemoryV3PendingTargetStore {
  loadAttempts = 0;

  override async load(): Promise<readonly V3PendingTarget[]> {
    this.loadAttempts += 1;
    if (this.loadAttempts === 1) throw new Error("pending store unavailable");
    return super.load();
  }
}

class RejectableLoadStore extends InMemoryV3PendingTargetStore {
  #rejectLoad: ((error: Error) => void) | undefined;
  #loadAttempts = 0;

  override load(): Promise<readonly V3PendingTarget[]> {
    this.#loadAttempts += 1;
    if (this.#loadAttempts > 1) return super.load();
    return new Promise((_, reject) => {
      this.#rejectLoad = reject;
    });
  }

  rejectLoad(): void {
    this.#rejectLoad?.(new Error("pending store unavailable"));
    this.#rejectLoad = undefined;
  }
}

class BlockingLoadStore extends InMemoryV3PendingTargetStore {
  #completeLoad: (() => void) | undefined;

  override load(): Promise<readonly V3PendingTarget[]> {
    return new Promise((resolve) => {
      this.#completeLoad = () => resolve([]);
    });
  }

  completeLoad(): void {
    this.#completeLoad?.();
    this.#completeLoad = undefined;
  }
}

class FailOnceRemoveStore extends InMemoryV3PendingTargetStore implements V3PendingTargetStore {
  removeAttempts = 0;

  override async remove(commandId: string): Promise<void> {
    this.removeAttempts += 1;
    if (this.removeAttempts === 1) throw new Error("pending store unavailable");
    await super.remove(commandId);
  }
}

class BlockingRemoveStore extends InMemoryV3PendingTargetStore {
  removeAttempts = 0;
  readonly #removalWaiters: Array<() => void> = [];

  override async remove(commandId: string): Promise<void> {
    this.removeAttempts += 1;
    await new Promise<void>((resolve) => this.#removalWaiters.push(resolve));
    await super.remove(commandId);
  }

  completeRemovals(): void {
    for (const resolve of this.#removalWaiters.splice(0)) resolve();
  }
}

class DeleteThenRejectStore extends InMemoryV3PendingTargetStore {
  #rejected = false;

  override async remove(commandId: string): Promise<void> {
    await super.remove(commandId);
    if (this.#rejected) return;
    this.#rejected = true;
    throw new Error("ambiguous pending-store removal");
  }
}

class AlwaysFailRemoveStore extends InMemoryV3PendingTargetStore {
  override async remove(): Promise<void> {
    throw new Error("pending store unavailable");
  }
}

class TestMediaPlane implements V3ClientMediaPlane {
  readonly targets: V3MediaPlaneTarget[] = [];
  readonly results: V3MediaPlaneResult[] = [];
  #localListener: ((publications: readonly V3MediaPublication[]) => void) | undefined;
  #remoteListener: ((publications: readonly V3MediaPublication[]) => void) | undefined;

  async setLocalPublicationTarget(target: V3MediaPlaneTarget): Promise<V3MediaPlaneResult> {
    this.targets.push({ ...target });
    return this.results.shift() ?? { outcome: "confirmed", errorCode: null };
  }

  observeLocalPublications(listener: (publications: readonly V3MediaPublication[]) => void): () => void {
    this.#localListener = listener;
    return () => {
      this.#localListener = undefined;
    };
  }

  observeRemotePublications(listener: (publications: readonly V3MediaPublication[]) => void): () => void {
    this.#remoteListener = listener;
    return () => {
      this.#remoteListener = undefined;
    };
  }

  emitLocal(publications: readonly V3MediaPublication[]): void {
    this.#localListener?.(publications);
  }

  emitRemote(publications: readonly V3MediaPublication[]): void {
    this.#remoteListener?.(publications);
  }
}

class CountingMediaPlane extends TestMediaPlane {
  observerSubscriptions = 0;

  override observeLocalPublications(listener: (publications: readonly V3MediaPublication[]) => void): () => void {
    this.observerSubscriptions += 1;
    return super.observeLocalPublications(listener);
  }

  override observeRemotePublications(listener: (publications: readonly V3MediaPublication[]) => void): () => void {
    this.observerSubscriptions += 1;
    return super.observeRemotePublications(listener);
  }
}

class BlockingMediaPlane extends TestMediaPlane {
  #resolve: ((result: V3MediaPlaneResult) => void) | undefined;

  override setLocalPublicationTarget(target: V3MediaPlaneTarget): Promise<V3MediaPlaneResult> {
    this.targets.push({ ...target });
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  complete(result: V3MediaPlaneResult): void {
    this.#resolve?.(result);
    this.#resolve = undefined;
  }
}

async function exerciseConflictingControlEvidence(): Promise<void> {
  const { client, socket, state } = await liveClient();
  const next = { ...state, revision: 2, stateDigest: "0".repeat(64), participants: state.participants.map((participant) => ({ ...participant, handRaised: true })) };
  const digest = await computeV3StateDigest(next);
  const exact = {
    type: "event",
    stream: "control",
    name: "hand_raised",
    event_id: recoveryId,
    base_revision: 1,
    revision: 2,
    schema_version: 3,
    resulting_state_digest: digest,
    payload: { participant_session_id: hostId },
    command_id: commandIds[0],
  } as const;
  const exactApplied = snapshotWhen(client, (snapshot) => snapshot.control?.revision === 2);
  socket.receive(exact);
  socket.receive(exact);
  await exactApplied;
  expect(client.getSnapshot().connection.phase).toBe("live");
  const recovering = snapshotWhen(client, (snapshot) => snapshot.connection.phase === "connecting");
  socket.receive({ ...exact, event_id: projectionId });
  await recovering;
  expect(client.getSnapshot().connection.phase).toBe("connecting");
  client.stop();
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function snapshotWhen(client: V3SyncClient, predicate: (snapshot: V3SessionSnapshot) => boolean): Promise<V3SessionSnapshot> {
  const current = client.getSnapshot();
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve) => {
    const unsubscribe = client.subscribe((snapshot) => {
      if (!predicate(snapshot)) return;
      unsubscribe();
      resolve(snapshot);
    });
  });
}

function operationFrames(socket: TestSocket, commandId: string): Record<string, unknown>[] {
  return socket.frames().filter((frame) => (frame.type === "operation" || frame.type === "command") && frame.command_id === commandId);
}
