import { describe, expect, it } from "vitest";
import type { SnapshotSchema } from "../generated/sync-v3";
import { computeV3StateDigest } from "./v3-reducer";
import { V3SyncClient } from "./v3-client";
import type { SyncSocket } from "./types";
import type { V3ControlState } from "./v3-types";

type Snapshot = typeof SnapshotSchema.Type;

const participantId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";
const peerId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22";
const recoveryId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23";
const projectionId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c24";
const requestIds = Array.from({ length: 12 }, (_, index) => `018f2f65-2a77-7a44-8e9a-${(0x5b0b6f8d4d00 + index).toString(16)}`);

describe("V3SyncClient room_actions_v2", () => {
  it("negotiates the extension and maps reactions, attachments, reads, and pages", async () => {
    const { client, socket } = await liveRoomActionsClient();
    expect(socket.frames()[0]).toMatchObject({
      type: "hello",
      extensions: [{ name: "room_actions_v2", chat_cursor: { after_sequence: null, retained_floor_sequence: null } }],
    });
    expect(client.getRoomActionsExtensionState()).toEqual({
      negotiated: true,
      version: 2,
      capabilities: ["sendReaction", "sendChat"],
      chatHeadSequence: "8",
      retainedFloorSequence: "2",
      readReceipts: [
        {
          participantSessionId: peerId,
          participantSessionGeneration: 1,
          readThroughSequence: "7",
          readAt: "2026-07-29T12:00:00.000Z",
        },
      ],
    });
    expect(client.getParticipantRoomActionCapabilities()).toEqual({
      [participantId]: ["sendReaction", "sendChat"],
      [peerId]: ["sendReaction"],
    });

    const events: string[] = [];
    client.subscribeRoomActions((event) => events.push(event.type));

    const reaction = client.sendReaction("🎉");
    const reactionRequest = socket.frames().at(-1)!;
    socket.receive({
      type: "room_reaction_result",
      operation_id: reactionRequest.operation_id,
      outcome: "accepted",
      reaction: roomReaction(reactionRequest.operation_id as string),
    });
    await expect(reaction).resolves.toMatchObject({ reaction: "🎉", participantSessionId: participantId });

    const attachment = {
      attachmentId: requestIds[11]!,
      fileName: "notes.txt",
      mimeType: "text/plain" as const,
      byteLength: 128,
    };
    const chat = client.sendChatMessage({ text: "", attachments: [attachment], clientMessageId: requestIds[1] });
    expect(socket.frames().at(-1)).toMatchObject({ type: "chat_send", text: "", attachment_ids: [attachment.attachmentId] });
    socket.receive({ type: "chat_send_result", client_message_id: requestIds[1], outcome: "accepted", message: chatMessage("9", requestIds[1], [attachment]) });
    await expect(chat).resolves.toMatchObject({ text: "", sequence: "9", attachments: [attachment] });

    const read = client.markChatRead("9");
    const readRequest = socket.frames().at(-1)!;
    socket.receive({
      type: "chat_read_result",
      request_id: readRequest.request_id,
      outcome: "accepted",
      participant_session_id: participantId,
      participant_session_generation: 1,
      sequence: "9",
      read_at: "2026-07-29T12:01:00.000Z",
    });
    await expect(read).resolves.toMatchObject({ participantSessionId: participantId, readThroughSequence: "9" });

    const page = client.readChatPage({ beforeSequence: "9", limit: 20 });
    const pageRequest = socket.frames().at(-1)!;
    socket.receive({
      type: "chat_page",
      request_id: pageRequest.request_id,
      outcome: "loaded",
      messages: [chatMessage("3", requestIds[2], [])],
      has_more: false,
      head_sequence: "9",
      retained_floor_sequence: "2",
    });
    await expect(page).resolves.toEqual({ status: "loaded", count: 1, hasOlder: false });
    expect(events).toEqual(["chat_message"]);

    socket.receive(roomReaction(requestIds[3]));
    await settle();
    expect(events).toEqual(["chat_message", "reaction"]);
  });

  it("keeps room-action capacity separate from control traffic", async () => {
    const { client, socket, state } = await liveRoomActionsClient({ maxPendingRoomActions: 1 });
    void client.sendReaction("👍").catch(() => undefined);

    expect(() => client.sendReaction("❤️")).toThrowError(/room-action in-flight capacity/u);
    const control = client.setHandRaised(false, { commandId: requestIds[4] });
    socket.receive({
      type: "ack",
      command_id: requestIds[4],
      delivery: "original",
      outcome: "satisfied",
      revision: state.revision,
      state_digest: state.stateDigest,
    });
    await expect(control).resolves.toMatchObject({ outcome: "satisfied" });
  });

  it("emits cursor reset as data and updates retained-floor state", async () => {
    const { client, socket } = await liveRoomActionsClient();
    const events: string[] = [];
    client.subscribeRoomActions((event) => events.push(event.type));
    const page = client.readChatPage({ afterSequence: "1", limit: 100 });
    const request = socket.frames().at(-1)!;

    socket.receive({
      type: "chat_page",
      request_id: request.request_id,
      outcome: "cursor_reset",
      retained_floor_sequence: "4",
    });

    await expect(page).resolves.toEqual({ status: "cursor_reset", retainedFloorSequence: "4" });
    expect(events).toEqual(["chat_cursor_reset"]);
    expect(client.getRoomActionsExtensionState().retainedFloorSequence).toBe("4");
  });

  it("falls back from v2 to v1 only once when invalid_frame and close 1009 reject the same hello", async () => {
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
    await client.start();
    sockets[0]!.open();
    await settle();
    expect(sockets[0]!.frames()[0]).toMatchObject({ extensions: [{ name: "room_actions_v2" }] });

    sockets[0]!.dispatchesClientClose = false;
    sockets[0]!.receive({ type: "error", code: "invalid_frame", detail: "invalid frame" });
    await settle();
    expect(sockets[0]!.closeCalls).toEqual([{ code: 4000, reason: "room actions unsupported" }]);
    sockets[0]!.remoteClose(1009);
    for (let attempt = 0; attempt < 50 && sockets.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    await settle();
    expect(sockets[1]!.frames()[0]).toMatchObject({ extensions: [{ name: "room_actions_v1" }] });

    const { state } = await recover(sockets[1]!, "v1");
    expect(client.getSnapshot()).toMatchObject({ connection: { phase: "live" }, control: { revision: state.revision } });
    expect(client.getRoomActionsExtensionState()).toMatchObject({ negotiated: true, version: 1, capabilities: ["sendReaction", "sendChat"] });
    expect(() => client.sendChatMessage({ text: "", attachments: [{ attachmentId: requestIds[11]!, fileName: "notes.txt", mimeType: "text/plain", byteLength: 1 }] })).toThrowError(/require room_actions_v2/u);
  });
});

async function liveRoomActionsClient(overrides: Partial<ConstructorParameters<typeof V3SyncClient>[0]> = {}) {
  const socket = new TestSocket();
  const ids = [...requestIds];
  const client = new V3SyncClient({
    url: "ws://sync.test/v3/sync",
    token: async () => "token",
    requestIds: { next: () => ids.shift()! },
    webSocket: { connect: () => socket },
    ...overrides,
  });
  await client.start();
  socket.open();
  await settle();
  const { state } = await recover(socket, "v2");
  expect(socket.closeCalls).toEqual([]);
  expect(client.getSnapshot()).toMatchObject({
    connection: { phase: "live" },
    media: { sequence: 0 },
    presence: { sequence: 0 },
  });
  return { client, socket, state };
}

async function recover(socket: TestSocket, extensionVersion: "v1" | "v2" | false) {
  const state = await stateWithDigest();
  const welcome = {
    type: "welcome",
    protocol: 3,
    participant_session_id: participantId,
    participant_session_generation: 1,
    recovery_id: recoveryId,
    head: { revision: state.revision, state_schema_version: state.stateSchemaVersion, state_digest: state.stateDigest },
    mode: "snapshot",
    snapshot: wireSnapshot(state),
    ...(extensionVersion
      ? {
          extensions: [
            extensionVersion === "v2"
              ? {
                  name: "room_actions_v2",
                  capabilities: ["sendReaction", "sendChat"],
                  participant_capabilities: {
                    [participantId]: ["sendReaction", "sendChat"],
                    [peerId]: ["sendReaction"],
                  },
                  chat_head_sequence: "8",
                  retained_floor_sequence: "2",
                  read_receipts: [
                    {
                      participant_session_id: peerId,
                      participant_session_generation: 1,
                      sequence: "7",
                      read_at: "2026-07-29T12:00:00.000Z",
                    },
                  ],
                }
              : {
                  name: "room_actions_v1",
                  capabilities: ["sendReaction", "sendChat"],
                  participant_capabilities: {
                    [participantId]: ["sendReaction", "sendChat"],
                    [peerId]: ["sendReaction"],
                  },
                  chat_head_sequence: "8",
                  retained_floor_sequence: "2",
                },
          ],
        }
      : {}),
  };
  socket.receive(welcome);
  await settle();
  socket.receive({ type: "projection_snapshot", stream: "media", projection_id: projectionId, sequence: 0, items: [] });
  socket.receive({ type: "projection_snapshot", stream: "presence", projection_id: projectionId, sequence: 0, items: [] });
  socket.receive({
    type: "recovery_complete",
    recovery_id: recoveryId,
    head: { revision: state.revision, state_schema_version: state.stateSchemaVersion, state_digest: state.stateDigest },
  });
  for (let attempt = 0; attempt < 50; attempt += 1) await settle();
  return { state };
}

function baseState(): V3ControlState {
  return {
    revision: 1,
    stateSchemaVersion: 3,
    stateDigest: "0".repeat(64),
    status: "active",
    admissionPolicy: "open",
    hostExitPolicy: "require_transfer",
    hostParticipantSessionId: participantId,
    deadlineAtMs: 99_999,
    deadlineGeneration: 1,
    roleCapabilities: { host: ["publishAudio", "endMeeting"], cohost: ["publishAudio"], participant: ["subscribe"] },
    recording: null,
    participants: [
      {
        participantSessionId: participantId,
        displayName: "Host",
        handRaised: false,
        admissionRevision: 1,
        role: "host",
        eligibleRoles: ["host", "cohost"],
        capabilities: ["publishAudio", "endMeeting"],
      },
    ],
    admissionRequests: [],
  };
}

async function stateWithDigest() {
  const state = baseState();
  return { ...state, stateDigest: await computeV3StateDigest(state) };
}

function wireSnapshot(state: V3ControlState): Snapshot {
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

function roomReaction(id: string) {
  return {
    type: "room_reaction",
    event_id: id,
    participant_session_id: participantId,
    display_name: "Host",
    reaction: "🎉",
    occurred_at: "2026-07-29T12:00:00.000Z",
    expires_at: "2026-07-29T12:00:05.000Z",
  } as const;
}

function chatMessage(sequence: string, clientMessageId: string, attachments: readonly { readonly attachmentId: string; readonly fileName: string; readonly mimeType: "text/plain"; readonly byteLength: number }[]) {
  return {
    type: "chat_message",
    message_id: requestIds[0]!,
    client_message_id: clientMessageId,
    sequence,
    participant_session_id: participantId,
    display_name: "Host",
    text: attachments.length === 0 ? "Hello" : "",
    attachments: attachments.map((attachment) => ({
      attachment_id: attachment.attachmentId,
      file_name: attachment.fileName,
      mime_type: attachment.mimeType,
      byte_length: attachment.byteLength,
    })),
    created_at: "2026-07-29T12:00:00.000Z",
  } as const;
}

class TestSocket implements SyncSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  readonly closeCalls: { readonly code: number; readonly reason: string | undefined }[] = [];
  dispatchesClientClose = true;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.dispatchesClientClose) this.onclose?.({ code });
  }

  remoteClose(code: number): void {
    this.onclose?.({ code });
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

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
