import type {
  ChalkChatMessage,
  ChalkChatPageResult,
  ChalkReaction,
  ChalkReactionEvent,
  ChalkSendChatMessageInput,
  ChalkSyncV1CollaborationCapability,
  V1AdmissionPolicy,
  V1AssignableRole,
  V1CollaborationEvent,
  V1CommandResult,
  V1DirectedRequest,
  V1DirectedRequestResult,
  V1MediaPlaneResult,
  V1MediaPlaneTarget,
  V1MediaSource,
  V1SelfMediaTargetResult,
  V1EpisodeSnapshot,
} from "@q9labsai/chalk-client";

import { initialEpisodeSnapshot, episodeSnapshot, type ServerMessage } from "./protocol";
import { registerSocket } from "./resource-ledger";

type PendingRequest<T> = {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
};
type ServerMessageOf<Type extends ServerMessage["type"]> = Extract<ServerMessage, { readonly type: Type }>;
type ServerMessageHandlers = {
  readonly [Type in ServerMessage["type"]]: (message: ServerMessageOf<Type>) => void;
};
type CollaborationResult = ServerMessageOf<"collaboration_result">;

type FixtureSyncClientInput = {
  readonly access: {
    readonly subject: {
      readonly participantId: string;
      readonly participantGeneration: number;
    };
  };
  readonly token: () => Promise<string>;
  readonly media: {
    readonly setLocalPublicationTarget: (target: V1MediaPlaneTarget) => Promise<V1MediaPlaneResult>;
  };
};

export class FixtureSyncClient {
  readonly #access: FixtureSyncClientInput["access"];
  readonly #listeners = new Set<(snapshot: V1EpisodeSnapshot) => void>();
  readonly #collaborationListeners = new Set<(event: V1CollaborationEvent) => void>();
  readonly #directedRequestListeners = new Set<(request: V1DirectedRequest) => void>();
  readonly #media: FixtureSyncClientInput["media"];
  readonly #syncURL: string;
  readonly #token: () => Promise<string>;
  #pending = new Map<string, PendingRequest<V1CommandResult>>();
  #pendingCollaborations = new Map<string, PendingRequest<CollaborationResult>>();
  #pendingDirectedRequests = new Map<string, PendingRequest<V1DirectedRequestResult>>();
  #snapshot: V1EpisodeSnapshot;
  #socket: WebSocket | null = null;
  readonly #messageHandlers: ServerMessageHandlers = {
    state: (message) => this.#publish(episodeSnapshot(this.#snapshot, message.state)),
    ack: (message) => resolvePending(this.#pending, message.id, commandAcknowledgement(message.id)),
    collaboration_event: (message) => this.#emitCollaboration(message.event),
    collaboration_result: (message) => resolvePending(this.#pendingCollaborations, message.id, message),
    directed_request: (message) => this.#emitDirectedRequest(message.request),
    directed_request_result: (message) => resolvePending(this.#pendingDirectedRequests, message.id, message.result),
    peers: ignoreServerMessage,
    signal: ignoreServerMessage,
    force_failure: ignoreServerMessage,
  };

  constructor(syncURL: string, input: FixtureSyncClientInput) {
    this.#syncURL = syncURL;
    this.#access = input.access;
    this.#token = input.token;
    this.#media = input.media;
    this.#snapshot = initialEpisodeSnapshot(input.access.subject.participantId, input.access.subject.participantGeneration);
  }

  getSnapshot = () => this.#snapshot;

  subscribe = (listener: (snapshot: V1EpisodeSnapshot) => void) => {
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
  setAdmissionPolicy = (policy: V1AdmissionPolicy) => this.#command("set_admission_policy", { policy });
  assignRole = (participantId: string, role: V1AssignableRole) => this.#command("assign_roles", { participant_id: participantId, role });
  admit = (admissionRequestId: string) => this.#command("admit_participant", { admission_request_id: admissionRequestId });
  deny = (admissionRequestId: string) => this.#command("deny_admission", { admission_request_id: admissionRequestId });
  muteParticipant = (participantId: string) => this.#command("mute_participant", { participant_id: participantId });
  stopParticipantCamera = (participantId: string) => this.#command("stop_participant_camera", { participant_id: participantId });
  stopParticipantScreenShare = (participantId: string) => this.#command("stop_participant_screen_share", { participant_id: participantId });
  removeParticipant = (participantId: string) => this.#command("remove_participant", { participant_id: participantId });
  endEpisode = () => this.#command("end_episode", {});
  extendEpisode = (minutes: number) => this.#command("extend_episode", { minutes });

  getCollaborationExtensionState = () => ({
    negotiated: true,
    version: 1 as const,
    capabilities: ["sendReaction", "sendChat"] as const,
    chatHeadSequence: null,
    retainedFloorSequence: null,
    readReceipts: [],
  });

  getParticipantCollaborationCapabilities = (): Readonly<Record<string, readonly ChalkSyncV1CollaborationCapability[]>> => Object.fromEntries(this.#snapshot.control?.participants.map((participant) => [participant.participantId, ["sendReaction", "sendChat"] as const]) ?? []);

  subscribeCollaboration = (listener: (event: V1CollaborationEvent) => void) => {
    this.#collaborationListeners.add(listener);
    return () => this.#collaborationListeners.delete(listener);
  };

  async sendReaction(reaction: ChalkReaction): Promise<ChalkReactionEvent> {
    const result = await this.#collaboration("send_reaction", { reaction });
    if (!result.reaction) throw new TypeError("Fixture reaction response was incomplete");
    return result.reaction;
  }

  async sendChatMessage(input: ChalkSendChatMessageInput): Promise<ChalkChatMessage> {
    const result = await this.#collaboration("send_chat", input);
    if (!result.message) throw new TypeError("Fixture chat response was incomplete");
    return result.message;
  }

  async markChatRead(sequence: string) {
    return {
      participantId: this.#access.subject.participantId,
      participantGeneration: this.#access.subject.participantGeneration,
      readThroughSequence: sequence,
      readAt: new Date().toISOString(),
    };
  }

  async readChatPage(input: { readonly beforeSequence?: string; readonly afterSequence?: string; readonly limit: number }): Promise<ChalkChatPageResult> {
    const result = await this.#collaboration("read_chat_page", input);
    const messages = result.messages ?? [];
    this.#emitChatMessages(messages);
    return loadedChatPage(messages.length);
  }

  onDirectedRequest = (listener: (request: V1DirectedRequest) => void) => {
    this.#directedRequestListeners.add(listener);
    return () => this.#directedRequestListeners.delete(listener);
  };

  requestUnmute = (participantId: string) => this.#directedRequest("request_unmute", participantId);
  requestStartCamera = (participantId: string) => this.#directedRequest("request_start_camera", participantId);

  setMicrophoneEnabled = (enabled: boolean) => this.#setMedia("microphone", enabled, "set_microphone_enabled");
  setCameraEnabled = (enabled: boolean) => this.#setMedia("camera", enabled, "set_camera_enabled");
  setScreenShareEnabled = (enabled: boolean) => this.#setMedia("screen", enabled, "set_screen_share_enabled");

  async #setMedia(source: V1MediaSource, enabled: boolean, name: V1SelfMediaTargetResult["name"]): Promise<V1SelfMediaTargetResult> {
    const operationId = crypto.randomUUID();
    const mediaResult = await this.#media.setLocalPublicationTarget({ operationId, participantId: this.#access.subject.participantId, source, enabled });
    if (mediaResult.outcome !== "confirmed" && mediaResult.outcome !== "satisfied") throw new TypeError(`Fixture media rejected ${source}`);
    await this.#command(name, { source, enabled });
    return { operationId, name, serverOutcome: "confirmed", mediaPlaneOutcome: mediaResult.outcome };
  }

  #command(name: string, payload: Record<string, unknown>): Promise<V1CommandResult> {
    return this.#request(this.#pending, { type: "command", name, payload });
  }

  #collaboration(name: string, payload: Record<string, unknown>): Promise<CollaborationResult> {
    return this.#request(this.#pendingCollaborations, { type: "collaboration", name, payload });
  }

  #directedRequest(name: string, participantId: string): Promise<V1DirectedRequestResult> {
    return this.#request(this.#pendingDirectedRequests, { type: "directed_request", name, target_participant_id: participantId });
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
    rejectPending(this.#pendingCollaborations, error);
    rejectPending(this.#pendingDirectedRequests, error);
    this.#publishTerminalDisconnect();
  }

  #publishTerminalDisconnect(): void {
    if (this.#snapshot.connection.phase === "stopped") return;
    this.#publish({ ...this.#snapshot, connection: { phase: "terminal", terminalReason: "fixture_disconnect" } });
  }

  #emitChatMessages(messages: readonly ChalkChatMessage[]): void {
    for (const message of messages) this.#emitCollaboration({ type: "chat_message", message });
  }

  #emitDirectedRequest(request: V1DirectedRequest): void {
    for (const listener of this.#directedRequestListeners) listener(request);
  }

  #emitCollaboration(event: V1CollaborationEvent): void {
    for (const listener of this.#collaborationListeners) listener(event);
  }

  #publish(snapshot: V1EpisodeSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}

export function bindFixtureSyncClient(client: FixtureSyncClient) {
  return {
    getSnapshot: client.getSnapshot,
    subscribe: client.subscribe,
    start: client.start.bind(client),
    stop: client.stop,
    leave: client.leave,
    setHandRaised: client.setHandRaised,
    setDisplayName: client.setDisplayName,
    setAdmissionPolicy: client.setAdmissionPolicy,
    assignRole: client.assignRole,
    admit: client.admit,
    deny: client.deny,
    muteParticipant: client.muteParticipant,
    stopParticipantCamera: client.stopParticipantCamera,
    stopParticipantScreenShare: client.stopParticipantScreenShare,
    removeParticipant: client.removeParticipant,
    endEpisode: client.endEpisode,
    extendEpisode: client.extendEpisode,
    getCollaborationExtensionState: client.getCollaborationExtensionState,
    getParticipantCollaborationCapabilities: client.getParticipantCollaborationCapabilities,
    subscribeCollaboration: client.subscribeCollaboration,
    sendReaction: client.sendReaction.bind(client),
    sendChatMessage: client.sendChatMessage.bind(client),
    markChatRead: client.markChatRead.bind(client),
    readChatPage: client.readChatPage.bind(client),
    onDirectedRequest: client.onDirectedRequest,
    requestUnmute: client.requestUnmute,
    requestStartCamera: client.requestStartCamera,
    setMicrophoneEnabled: client.setMicrophoneEnabled,
    setCameraEnabled: client.setCameraEnabled,
    setScreenShareEnabled: client.setScreenShareEnabled,
  };
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
