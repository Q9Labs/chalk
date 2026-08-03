// Fallow cannot see that ChalkSession consumes this adapter through the ChalkSessionSyncClient interface.
// fallow-ignore-file unused-class-member
import type {
  ChalkChatMessage,
  ChalkChatPageResult,
  ChalkReaction,
  ChalkRoomReaction,
  ChalkSendChatMessageInput,
  ChalkSessionSyncClient,
  ChalkSyncV1RoomActionCapability,
  V1AssignableRole,
  V1CommandResult,
  V1DirectedRequest,
  V1DirectedRequestResult,
  V1MediaSource,
  V1RoomActionClientEvent,
  V1SelfMediaTargetResult,
  V1SessionSnapshot,
} from "@q9labsai/chalk-client";
import type { ChalkSessionMediaClient, ChalkSessionSyncFactoryInput } from "@q9labsai/chalk-client";

import { initialSyncSnapshot, syncSnapshot, type ServerMessage } from "./protocol";
import { registerSocket } from "./resource-ledger";

type PendingRequest<T> = {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
};
type ServerMessageOf<Type extends ServerMessage["type"]> = Extract<ServerMessage, { readonly type: Type }>;
type ServerMessageHandlers = {
  readonly [Type in ServerMessage["type"]]: (message: ServerMessageOf<Type>) => void;
};
type RoomActionResult = ServerMessageOf<"room_action_result">;

export class FixtureSyncClient implements ChalkSessionSyncClient {
  readonly #access: ChalkSessionSyncFactoryInput["access"];
  readonly #listeners = new Set<(snapshot: V1SessionSnapshot) => void>();
  readonly #roomActionListeners = new Set<(event: V1RoomActionClientEvent) => void>();
  readonly #directedRequestListeners = new Set<(request: V1DirectedRequest) => void>();
  readonly #media: ChalkSessionMediaClient;
  readonly #syncURL: string;
  readonly #token: () => Promise<string>;
  #pending = new Map<string, PendingRequest<V1CommandResult>>();
  #pendingRoomActions = new Map<string, PendingRequest<RoomActionResult>>();
  #pendingDirectedRequests = new Map<string, PendingRequest<V1DirectedRequestResult>>();
  #snapshot: V1SessionSnapshot;
  #socket: WebSocket | null = null;
  readonly #messageHandlers: ServerMessageHandlers = {
    state: (message) => this.#publish(syncSnapshot(this.#snapshot, message.state)),
    ack: (message) => resolvePending(this.#pending, message.id, commandAcknowledgement(message.id)),
    room_action_event: (message) => this.#emitRoomAction(message.event),
    room_action_result: (message) => resolvePending(this.#pendingRoomActions, message.id, message),
    directed_request: (message) => this.#emitDirectedRequest(message.request),
    directed_request_result: (message) => resolvePending(this.#pendingDirectedRequests, message.id, message.result),
    peers: ignoreServerMessage,
    signal: ignoreServerMessage,
    force_failure: ignoreServerMessage,
  };

  constructor(syncURL: string, input: ChalkSessionSyncFactoryInput) {
    this.#syncURL = syncURL;
    this.#access = input.access;
    this.#token = input.token;
    this.#media = input.media;
    this.#snapshot = initialSyncSnapshot(input.access.subject.participantSessionId, input.access.subject.participantGeneration);
  }

  getSnapshot = () => this.#snapshot;

  subscribe = (listener: (snapshot: V1SessionSnapshot) => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async start(): Promise<void> {
    const token = await this.#token();
    this.#publish({ ...this.#snapshot, connection: { phase: "connecting" } });
    await new Promise<void>((resolve, reject) => {
      const socket = registerSocket(new WebSocket(`${this.#syncURL}?token=${encodeURIComponent(token)}`));
      this.#socket = socket;
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new TypeError("Fixture Sync socket failed")), { once: true });
      socket.addEventListener("message", (event) => this.#onMessage(JSON.parse(String(event.data)) as ServerMessage));
      socket.addEventListener("close", () => this.#handleSocketClose(socket));
    });
  }

  stop = (): void => {
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
    this.#publish({ ...this.#snapshot, connection: { phase: "stopped" } });
  };

  leave = () => this.#command("participant_leave", {});
  setHandRaised = (raised: boolean) => this.#command("set_hand_raised", { raised });
  setDisplayName = (displayName: string) => this.#command("set_display_name", { display_name: displayName });
  setAdmissionPolicy = (policy: string) => this.#command("set_admission_policy", { policy });
  setParticipantRole = (participantSessionId: string, role: V1AssignableRole) => this.#command("assign_roles", { participant_id: participantSessionId, role });
  transferHost = (participantSessionId: string) => this.#command("assign_roles", { participant_id: participantSessionId, role: "host" });
  admit = (admissionRequestId: string) => this.#command("admit_participant", { admission_request_id: admissionRequestId });
  deny = (admissionRequestId: string) => this.#command("deny_admission", { admission_request_id: admissionRequestId });
  muteParticipant = (participantSessionId: string) => this.#command("mute_participant", { participant_id: participantSessionId });
  stopParticipantCamera = (participantSessionId: string) => this.#command("stop_participant_camera", { participant_id: participantSessionId });
  stopParticipantScreenShare = (participantSessionId: string) => this.#command("stop_participant_screen_share", { participant_id: participantSessionId });
  removeParticipant = (participantSessionId: string) => this.#command("remove_participant", { participant_id: participantSessionId });
  endSession = () => this.#command("end_episode", {});

  getRoomActionsExtensionState = () => ({
    negotiated: true,
    version: 1 as const,
    capabilities: ["sendReaction", "sendChat"] as const,
    chatHeadSequence: null,
    retainedFloorSequence: null,
    readReceipts: [],
  });

  getParticipantRoomActionCapabilities = (): Readonly<Record<string, readonly ChalkSyncV1RoomActionCapability[]>> => Object.fromEntries(this.#snapshot.control?.participants.map((participant) => [participant.participantSessionId, ["sendReaction", "sendChat"] as const]) ?? []);

  subscribeRoomActions = (listener: (event: V1RoomActionClientEvent) => void) => {
    this.#roomActionListeners.add(listener);
    return () => this.#roomActionListeners.delete(listener);
  };

  async sendReaction(reaction: ChalkReaction): Promise<ChalkRoomReaction> {
    const result = await this.#roomAction("send_reaction", { reaction });
    if (!result.reaction) throw new TypeError("Fixture reaction response was incomplete");
    return result.reaction;
  }

  async sendChatMessage(input: ChalkSendChatMessageInput): Promise<ChalkChatMessage> {
    const result = await this.#roomAction("send_chat", input);
    if (!result.message) throw new TypeError("Fixture chat response was incomplete");
    return result.message;
  }

  async markChatRead(sequence: string) {
    return {
      participantSessionId: this.#access.subject.participantSessionId,
      participantSessionGeneration: this.#access.subject.participantGeneration,
      readThroughSequence: sequence,
      readAt: new Date().toISOString(),
    };
  }

  async readChatPage(input: { readonly beforeSequence?: string; readonly afterSequence?: string; readonly limit: number }): Promise<ChalkChatPageResult> {
    const result = await this.#roomAction("read_chat_page", input);
    const messages = result.messages ?? [];
    this.#emitChatMessages(messages);
    return loadedChatPage(messages.length);
  }

  onDirectedRequest = (listener: (request: V1DirectedRequest) => void) => {
    this.#directedRequestListeners.add(listener);
    return () => this.#directedRequestListeners.delete(listener);
  };

  requestUnmute = (participantSessionId: string) => this.#directedRequest("request_unmute", participantSessionId);
  requestStartCamera = (participantSessionId: string) => this.#directedRequest("request_start_camera", participantSessionId);

  setMicrophoneEnabled = (enabled: boolean) => this.#setMedia("microphone", enabled, "set_microphone_enabled");
  setCameraEnabled = (enabled: boolean) => this.#setMedia("camera", enabled, "set_camera_enabled");
  setScreenShareEnabled = (enabled: boolean) => this.#setMedia("screen", enabled, "set_screen_share_enabled");

  async #setMedia(source: V1MediaSource, enabled: boolean, name: V1SelfMediaTargetResult["name"]): Promise<V1SelfMediaTargetResult> {
    const operationId = crypto.randomUUID();
    const mediaResult = await this.#media.setLocalPublicationTarget({ operationId, participantSessionId: this.#access.subject.participantSessionId, source, enabled });
    if (mediaResult.outcome !== "confirmed" && mediaResult.outcome !== "satisfied") throw new TypeError(`Fixture media rejected ${source}`);
    await this.#command(name, { source, enabled });
    return { operationId, name, serverOutcome: "confirmed", mediaPlaneOutcome: mediaResult.outcome };
  }

  #command(name: string, payload: Record<string, unknown>): Promise<V1CommandResult> {
    return this.#request(this.#pending, { type: "command", name, payload });
  }

  #roomAction(name: string, payload: Record<string, unknown>): Promise<RoomActionResult> {
    return this.#request(this.#pendingRoomActions, { type: "room_action", name, payload });
  }

  #directedRequest(name: string, participantSessionId: string): Promise<V1DirectedRequestResult> {
    return this.#request(this.#pendingDirectedRequests, { type: "directed_request", name, target_participant_id: participantSessionId });
  }

  #request<T>(pendingRequests: Map<string, PendingRequest<T>>, request: Record<string, unknown>): Promise<T> {
    const id = crypto.randomUUID();
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new TypeError("Fixture Sync is not connected"));
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      socket.send(JSON.stringify({ ...request, id }));
    });
  }

  #onMessage(message: ServerMessage): void {
    dispatchServerMessage(this.#messageHandlers, message);
  }

  #handleSocketClose(socket: WebSocket): void {
    if (this.#socket !== socket) return;
    this.#socket = null;
    const error = new TypeError("Fixture Sync socket closed");
    rejectPending(this.#pending, error);
    rejectPending(this.#pendingRoomActions, error);
    rejectPending(this.#pendingDirectedRequests, error);
    this.#publishTerminalDisconnect();
  }

  #publishTerminalDisconnect(): void {
    if (this.#snapshot.connection.phase === "stopped") return;
    this.#publish({ ...this.#snapshot, connection: { phase: "terminal", terminalReason: "fixture_disconnect" } });
  }

  #emitChatMessages(messages: readonly ChalkChatMessage[]): void {
    for (const message of messages) this.#emitRoomAction({ type: "chat_message", message });
  }

  #emitDirectedRequest(request: V1DirectedRequest): void {
    for (const listener of this.#directedRequestListeners) listener(request);
  }

  #emitRoomAction(event: V1RoomActionClientEvent): void {
    for (const listener of this.#roomActionListeners) listener(event);
  }

  #publish(snapshot: V1SessionSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}

function dispatchServerMessage(handlers: ServerMessageHandlers, message: ServerMessage): void {
  const handler = handlers[message.type] as (value: ServerMessage) => void;
  handler(message);
}

function resolvePending<T>(pendingRequests: Map<string, PendingRequest<T>>, id: string, value: T): void {
  const pending = pendingRequests.get(id);
  if (!pending) return;
  pendingRequests.delete(id);
  pending.resolve(value);
}

function rejectPending<T>(pendingRequests: Map<string, PendingRequest<T>>, error: Error): void {
  for (const pending of pendingRequests.values()) pending.reject(error);
  pendingRequests.clear();
}

function commandAcknowledgement(id: string): V1CommandResult {
  return { type: "ack", command_id: id, delivery: "original", outcome: "satisfied", revision: 1, state_digest: "fixture" } as V1CommandResult;
}

function loadedChatPage(count: number): ChalkChatPageResult {
  return { status: "loaded", count, hasOlder: false };
}

function ignoreServerMessage(_message: ServerMessage): void {}
