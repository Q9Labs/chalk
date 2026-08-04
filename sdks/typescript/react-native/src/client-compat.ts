export * from "@q9labsai/chalk-client";

import type { AdmissionRequest, Capability, ChatAttachment, ChatFilesController, ChatMessage, ChatReadReceipt, ChatSendInput, ClientFailure, IncomingMediaRequest, LocalMedia, MediaSource, Participant, Reaction, RemoteMedia, SpaceClient, SpaceSnapshot, WhiteboardSlice } from "@q9labsai/chalk-client";

export type { ChatAttachment, ChatFilesController, ChatMessage, ChatReadReceipt, ClientFailure, IncomingMediaRequest, LocalMedia, MediaSource, Participant, Reaction, RemoteMedia, SpaceClient, SpaceSnapshot } from "@q9labsai/chalk-client";
export type { ChalkChatAttachment, ChalkChatReadReceipt, ChalkChatPageResult, ChalkDirectedRequestResult, ChalkWhiteboardSummary, ChalkWhiteboardV1Event, ChalkWhiteboardV1Transport } from "@q9labsai/chalk-client";
import type { ChalkChatPageResult, ChalkDirectedRequestResult } from "@q9labsai/chalk-client";

export type NativeMediaSource = MediaSource;
export type NativeLocalMedia = LocalMedia;
export type NativeRemoteMedia = RemoteMedia;
export type NativeParticipant = Participant;
export type NativeAssignableParticipantRole = string;
export type NativeAdmissionPolicy = "open" | "knock" | "members_only";

export type NativeClientFailure = ClientFailure & {
  readonly action: string | null;
};

export type NativePendingChatMessage = {
  readonly clientMessageId: string;
  readonly text: string;
  readonly attachments: readonly ChatAttachment[];
  readonly state: "sending" | "failed";
  readonly error: NativeClientFailure | null;
};

export type NativeSpaceSnapshot = {
  readonly state: SpaceSnapshot["connection"]["status"];
  readonly subject: { readonly episodeId: string; readonly participantId: string; readonly participantGeneration: number } | null;
  readonly connection: {
    readonly sync: "idle" | "connecting" | "healthy" | "recovering" | "failed" | "stopped";
    readonly media: "idle" | "connecting" | "healthy" | "recovering" | "failed" | "stopped";
  };
  readonly admissionPolicy: NativeAdmissionPolicy | null;
  readonly participants: readonly NativeParticipant[];
  readonly admissionRequests: readonly AdmissionRequest[];
  readonly localMedia: Readonly<Record<MediaSource, LocalMedia>>;
  readonly remoteMedia: readonly NativeRemoteMedia[];
  readonly failure: NativeClientFailure | null;
  readonly actions: {
    readonly phase: "disabled" | "negotiating" | "healthy" | "recovering" | "failed" | "stopped";
    readonly version: 1 | null;
    readonly capabilities: readonly Capability[];
    readonly error: NativeClientFailure | null;
  };
  readonly participantCapabilities: Readonly<Record<string, readonly Capability[]>>;
  readonly reactions: SpaceSnapshot["reactions"]["active"];
  readonly chat: {
    readonly status: "idle" | "loading" | "ready" | "failed";
    readonly messages: readonly ChatMessage[];
    readonly pending: readonly NativePendingChatMessage[];
    readonly hasOlder: boolean;
    readonly historyTruncated: boolean;
    readonly retainedFloorSequence: string | null;
    readonly unreadCount: number;
    readonly readReceipts: readonly ChatReadReceipt[];
    readonly localReadThroughSequence: string | null;
    readonly error: NativeClientFailure | null;
  };
  readonly whiteboard: WhiteboardSlice["engine"] & {
    readonly capabilities: readonly [];
    readonly canDraw: false;
    readonly canClear: false;
  };
  readonly incomingMediaRequests: readonly IncomingMediaRequest[];
};

export type SpaceClientActions = {
  readonly join: () => Promise<void>;
  readonly leave: () => Promise<void>;
  readonly setMicrophoneEnabled: (enabled: boolean) => Promise<void>;
  readonly setCameraEnabled: (enabled: boolean) => Promise<void>;
  readonly startScreenShare: () => Promise<void>;
  readonly stopScreenShare: () => Promise<void>;
  readonly setHandRaised: (raised: boolean) => Promise<void>;
  readonly setDisplayName: (displayName: string) => Promise<void>;
  readonly setAdmissionPolicy: (policy: NativeAdmissionPolicy) => Promise<void>;
  readonly assignRole: (participantId: string, role: string) => Promise<void>;
  readonly assignOwner: (participantId: string) => Promise<void>;
  readonly admitParticipant: (requestId: string) => Promise<void>;
  readonly denyAdmission: (requestId: string) => Promise<void>;
  readonly muteParticipant: (participantId: string) => Promise<void>;
  readonly stopParticipantCamera: (participantId: string) => Promise<void>;
  readonly stopParticipantScreenShare: (participantId: string) => Promise<void>;
  readonly removeParticipant: (participantId: string) => Promise<void>;
  readonly endEpisode: () => Promise<void>;
  readonly sendReaction: (reaction: Reaction) => Promise<SpaceSnapshot["reactions"]["active"][number]>;
  readonly sendChatMessage: (input: ChatSendInput) => Promise<ChatMessage>;
  readonly retryChatMessage: (clientMessageId: string) => Promise<ChatMessage>;
  readonly loadOlderChatMessages: (limit?: number) => Promise<ChalkChatPageResult>;
  readonly markChatRead: (throughSequence?: string) => Promise<ChatReadReceipt | null>;
  readonly requestUnmute: (participantId: string) => Promise<ChalkDirectedRequestResult>;
  readonly requestStartCamera: (participantId: string) => Promise<ChalkDirectedRequestResult>;
  readonly acceptMediaRequest: (requestId: string) => Promise<void>;
  readonly declineMediaRequest: (requestId: string) => Promise<void>;
};

export type NativeChatFiles = ChatFilesController & {
  readonly getDownloadUrl: (attachmentId: string) => Promise<{ readonly downloadUrl: string; readonly expiresAt: string }>;
};

export type SpaceClientStore = SpaceClientActions & {
  readonly getSnapshot: () => NativeSpaceSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose?: () => void;
  readonly chatFiles: NativeChatFiles;
  readonly whiteboard: ReturnType<SpaceClient["whiteboard"]["transport"]>;
};

// The established native component surface still imports these names. Wave 3
// owns its public rename; the adapter itself is canonical above.
export type ChalkSessionFailure = NativeClientFailure;
export type ChalkPendingChatMessage = NativePendingChatMessage;
export type ChalkSessionSnapshot = NativeSpaceSnapshot;
export type ChalkSessionActions = SpaceClientActions;
export type ChalkSessionStore = SpaceClientStore;
export type ChalkMediaSource = NativeMediaSource;
export type ChalkLocalMedia = NativeLocalMedia;
export type ChalkRemoteMedia = NativeRemoteMedia;
export type ChalkParticipant = NativeParticipant;
export type ChalkAssignableParticipantRole = NativeAssignableParticipantRole;
export type ChalkIncomingMediaRequest = IncomingMediaRequest;
export type ChalkReaction = Reaction;
export type ChalkSendChatMessageInput = ChatSendInput;

export class SpaceClientAdapter implements SpaceClientStore {
  readonly chatFiles: NativeChatFiles;
  readonly #client: SpaceClient;
  #sourceSnapshot: SpaceSnapshot | undefined;
  #snapshot: NativeSpaceSnapshot | undefined;
  #disposed = false;

  constructor(client: SpaceClient) {
    this.#client = client;
    this.chatFiles = {
      ...client.chat.files,
      getDownloadUrl: async (attachmentId) => ({
        downloadUrl: client.chat.files.url({ attachmentId, fileName: attachmentId, mimeType: "text/plain", byteLength: 1 }),
        expiresAt: new Date(0).toISOString(),
      }),
    };
  }

  readonly getSnapshot = (): NativeSpaceSnapshot => {
    const sourceSnapshot = this.#client.getSnapshot();
    if (sourceSnapshot !== this.#sourceSnapshot) {
      this.#sourceSnapshot = sourceSnapshot;
      this.#snapshot = adaptSnapshot(sourceSnapshot);
    }
    return this.#snapshot!;
  };
  readonly subscribe = (listener: () => void): (() => void) => this.#client.subscribe(listener);
  readonly join = (): Promise<void> => this.#client.join();
  readonly leave = (): Promise<void> => this.#client.leave();
  readonly setMicrophoneEnabled = (enabled: boolean): Promise<void> => this.#client.media.setMicrophoneEnabled(enabled);
  readonly setCameraEnabled = (enabled: boolean): Promise<void> => this.#client.media.setCameraEnabled(enabled);
  readonly startScreenShare = (): Promise<void> => this.#client.media.setScreenShareEnabled(true);
  readonly stopScreenShare = (): Promise<void> => this.#client.media.setScreenShareEnabled(false);
  readonly setHandRaised = (raised: boolean): Promise<void> => (raised ? this.#client.participants.raiseHand() : this.#client.participants.lowerHand());
  readonly setDisplayName = (displayName: string): Promise<void> => this.#client.participants.renameSelf(displayName);
  readonly setAdmissionPolicy = (): Promise<void> => Promise.reject(new Error("Admission policy changes are unavailable on this compatibility surface"));
  readonly assignRole = (participantId: string, role: string): Promise<void> => this.#client.participants.assignRole(participantId, role);
  readonly assignOwner = (participantId: string): Promise<void> => this.#client.participants.assignRole(participantId, "owner");
  readonly admitParticipant = (requestId: string): Promise<void> => this.#client.participants.admit(requestId);
  readonly denyAdmission = (requestId: string): Promise<void> => this.#client.participants.deny(requestId);
  readonly muteParticipant = (participantId: string): Promise<void> => this.#client.participants.mute(participantId);
  readonly stopParticipantCamera = (participantId: string): Promise<void> => this.#client.participants.stopVideo(participantId);
  readonly stopParticipantScreenShare = (participantId: string): Promise<void> => this.#client.participants.stopScreenShare(participantId);
  readonly removeParticipant = (participantId: string): Promise<void> => this.#client.participants.remove(participantId);
  readonly endEpisode = (): Promise<void> => this.#client.endEpisode();
  readonly sendReaction = (reaction: Reaction) => this.#client.reactions.send(reaction);
  readonly sendChatMessage = (input: ChatSendInput) => this.#client.chat.send(input);
  readonly retryChatMessage = (clientMessageId: string) => {
    const pending = this.getSnapshot().chat.pending.find((message) => message.clientMessageId === clientMessageId);
    if (!pending) return Promise.reject(new Error("The pending chat message is no longer available"));
    return this.sendChatMessage({ text: pending.text, attachments: pending.attachments });
  };
  readonly loadOlderChatMessages = (): Promise<ChalkChatPageResult> => this.#client.chat.loadOlder();
  readonly markChatRead = (throughSequence?: string) => {
    const messages = this.getSnapshot().chat.messages;
    const message = throughSequence ? messages.find((candidate) => candidate.sequence === throughSequence) : messages.at(-1);
    if (!message) return Promise.resolve(null);
    return this.#client.chat.markRead(message.messageId);
  };
  readonly requestUnmute = (participantId: string) => this.#client.participants.requestMedia(participantId, "microphone");
  readonly requestStartCamera = (participantId: string) => this.#client.participants.requestMedia(participantId, "camera");
  readonly acceptMediaRequest = (requestId: string): Promise<void> => this.#client.media.acceptRequest(requestId);
  readonly declineMediaRequest = (requestId: string): Promise<void> => this.#client.media.declineRequest(requestId);
  readonly dispose = (): void => {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#client.dispose();
  };

  get whiteboard() {
    return this.#client.whiteboard.transport();
  }
}

export type NativeLifecyclePhase = "prejoin" | "joining" | "waiting" | "active" | "reconnecting" | "ended";
export type NativeLifecyclePhaseInput = {
  readonly snapshot: Pick<NativeSpaceSnapshot, "state" | "failure" | "connection">;
  readonly hasAskedToJoin: boolean;
  readonly hasAskedToLeave: boolean;
};

export function deriveNativeLifecyclePhase(input: NativeLifecyclePhaseInput): NativeLifecyclePhase {
  if (input.hasAskedToLeave || input.snapshot.failure?.code === "episode.ended") return "ended";
  if (input.snapshot.state === "idle") return input.hasAskedToJoin ? "joining" : "prejoin";
  if (input.snapshot.state === "joining") return "joining";
  if (input.snapshot.state === "live") return input.snapshot.connection.sync === "recovering" || input.snapshot.connection.media === "recovering" ? "reconnecting" : "active";
  if (input.snapshot.state === "reconnecting") return "reconnecting";
  return "ended";
}

function adaptSnapshot(snapshot: SpaceSnapshot): NativeSpaceSnapshot {
  const failure = snapshot.connection.lastError ? adaptFailure(snapshot.connection.lastError) : null;
  return {
    state: snapshot.connection.status,
    subject: snapshot.self.participantId
      ? {
          episodeId: snapshot.connection.episode?.id ?? "",
          participantId: snapshot.self.participantId,
          participantGeneration: 1,
        }
      : null,
    connection: {
      sync: connectionPhase(snapshot.connection.status),
      media: connectionPhase(snapshot.connection.status),
    },
    admissionPolicy: null,
    participants: snapshot.participants.roster,
    admissionRequests: snapshot.participants.admissionQueue,
    localMedia: snapshot.media.local,
    remoteMedia: snapshot.media.remote,
    failure,
    actions: {
      phase: snapshot.connection.status === "live" ? "healthy" : snapshot.connection.status === "reconnecting" ? "recovering" : "disabled",
      version: snapshot.connection.status === "live" ? 1 : null,
      capabilities: snapshot.self.capabilities,
      error: failure,
    },
    participantCapabilities: Object.fromEntries(snapshot.participants.roster.map((participant) => [participant.participantId, participant.capabilities])),
    reactions: snapshot.reactions.active,
    chat: {
      status: snapshot.chat.status,
      messages: snapshot.chat.messages,
      pending: snapshot.chat.pendingSends.map((pending) => ({ ...pending, state: pending.status, error: pending.error ? adaptFailure(pending.error) : null })),
      hasOlder: snapshot.chat.pagination.hasOlder,
      historyTruncated: snapshot.chat.pagination.historyTruncated,
      retainedFloorSequence: snapshot.chat.pagination.cursor,
      unreadCount: snapshot.chat.unreadCount,
      readReceipts: snapshot.chat.readReceipts,
      localReadThroughSequence: null,
      error: snapshot.chat.lastError ? adaptFailure(snapshot.chat.lastError) : null,
    },
    whiteboard: {
      ...snapshot.whiteboard.engine,
      capabilities: [],
      canDraw: false,
      canClear: false,
    },
    incomingMediaRequests: snapshot.media.incomingRequests,
  };
}

function adaptFailure(failure: ClientFailure): NativeClientFailure {
  return { ...failure, action: null };
}

function connectionPhase(status: SpaceSnapshot["connection"]["status"]): NativeSpaceSnapshot["connection"]["sync"] {
  if (status === "joining") return "connecting";
  if (status === "live") return "healthy";
  if (status === "reconnecting") return "recovering";
  if (status === "failed") return "failed";
  if (status === "left") return "stopped";
  return "idle";
}
