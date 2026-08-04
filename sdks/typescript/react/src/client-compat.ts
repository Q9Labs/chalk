export * from "@q9labsai/chalk-client";

import type { ActiveReaction, AdmissionRequest, Capability, ChatAttachment, ChatFilesController, ChatMessage, ChatReadReceipt, ChatSendInput, ClientFailure, IncomingMediaRequest, LocalMedia, MediaSource, Participant, Reaction, RemoteMedia, SpaceClient, SpaceSnapshot } from "@q9labsai/chalk-client";

export type { ActiveReaction, AdmissionRequest, Capability, ChatAttachment, ChatFilesController, ChatMessage, ChatReadReceipt, ChatSendInput, ClientFailure, IncomingMediaRequest, LocalMedia, MediaSource, Participant, Reaction, RemoteMedia, SpaceClient, SpaceSnapshot };

export type SpaceMediaSource = MediaSource;
export type SpaceLocalMedia = LocalMedia;
export type SpaceRemoteMedia = RemoteMedia;
export type SpaceParticipant = Participant;
export type SpaceClientFailure = ClientFailure;
export type SpacePendingChatSend = SpaceSnapshot["chat"]["pendingSends"][number];

export type SpaceSnapshotView = {
  readonly connectionStatus: SpaceSnapshot["connection"]["status"];
  readonly self: { readonly participantId: string } | null;
  readonly participants: readonly SpaceParticipant[];
  readonly admissionRequests: readonly AdmissionRequest[];
  readonly localMedia: Readonly<Record<MediaSource, LocalMedia>>;
  readonly remoteMedia: readonly SpaceRemoteMedia[];
  readonly failure: SpaceClientFailure | null;
  readonly capabilities: readonly Capability[];
  readonly participantMediaById: Readonly<Record<string, Participant["media"]>>;
  readonly reactions: readonly ActiveReaction[];
  readonly chat: SpaceSnapshot["chat"];
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
  readonly assignParticipantRole: (participantId: string, role: string) => Promise<void>;
  readonly assignOwner: (participantId: string) => Promise<void>;
  readonly admitParticipant: (requestId: string) => Promise<void>;
  readonly denyAdmission: (requestId: string) => Promise<void>;
  readonly muteParticipant: (participantId: string) => Promise<void>;
  readonly stopParticipantCamera: (participantId: string) => Promise<void>;
  readonly stopParticipantScreenShare: (participantId: string) => Promise<void>;
  readonly removeParticipant: (participantId: string) => Promise<void>;
  readonly endEpisode: () => Promise<void>;
  readonly sendReaction: (reaction: Reaction) => Promise<ActiveReaction>;
  readonly sendChatMessage: (input: ChatSendInput) => Promise<ChatMessage>;
  readonly retryChatMessage: (clientMessageId: string) => Promise<ChatMessage>;
  readonly loadOlderChatMessages: () => ReturnType<SpaceClient["chat"]["loadOlder"]>;
  readonly markChatRead: (throughSequence?: string) => Promise<ChatReadReceipt | null>;
  readonly requestUnmute: (participantId: string) => ReturnType<SpaceClient["participants"]["requestMedia"]>;
  readonly requestStartCamera: (participantId: string) => ReturnType<SpaceClient["participants"]["requestMedia"]>;
  readonly acceptMediaRequest: (requestId: string) => Promise<void>;
  readonly declineMediaRequest: (requestId: string) => Promise<void>;
};

export type SpaceClientStore = SpaceClientActions & {
  readonly getSnapshot: () => SpaceSnapshotView;
  readonly subscribe: (listener: () => void) => () => void;
  readonly files: ChatFilesController;
  readonly whiteboard: ReturnType<SpaceClient["whiteboard"]["transport"]>;
};

export type SpaceClientStoreInput = SpaceClient | SpaceClientStore;

export class SpaceClientAdapter implements SpaceClientStore {
  readonly files: ChatFilesController;
  readonly #client: SpaceClient;
  #sourceSnapshot: SpaceSnapshot | undefined;
  #snapshot: SpaceSnapshotView | undefined;
  #disposed = false;

  constructor(client: SpaceClient) {
    this.#client = client;
    this.files = client.chat.files;
  }

  readonly getSnapshot = (): SpaceSnapshotView => {
    const sourceSnapshot = this.#client.getSnapshot();
    if (sourceSnapshot !== this.#sourceSnapshot) {
      this.#sourceSnapshot = sourceSnapshot;
      this.#snapshot = toSpaceSnapshot(sourceSnapshot);
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
  readonly assignParticipantRole = (participantId: string, role: string): Promise<void> => this.#client.participants.assignRole(participantId, role);
  readonly assignOwner = (participantId: string): Promise<void> => this.#client.participants.assignRole(participantId, "owner");
  readonly admitParticipant = (requestId: string): Promise<void> => this.#client.participants.admit(requestId);
  readonly denyAdmission = (requestId: string): Promise<void> => this.#client.participants.deny(requestId);
  readonly muteParticipant = (participantId: string): Promise<void> => this.#client.participants.mute(participantId);
  readonly stopParticipantCamera = (participantId: string): Promise<void> => this.#client.participants.stopVideo(participantId);
  readonly stopParticipantScreenShare = (participantId: string): Promise<void> => this.#client.participants.stopScreenShare(participantId);
  readonly removeParticipant = (participantId: string): Promise<void> => this.#client.participants.remove(participantId);
  readonly endEpisode = (): Promise<void> => this.#client.endEpisode();
  readonly sendReaction = (reaction: Reaction): Promise<ActiveReaction> => this.#client.reactions.send(reaction);
  readonly sendChatMessage = (input: ChatSendInput): Promise<ChatMessage> => this.#client.chat.send(input);
  readonly retryChatMessage = (clientMessageId: string): Promise<ChatMessage> => {
    const pending = this.getSnapshot().chat.pendingSends.find((message) => message.clientMessageId === clientMessageId);
    if (!pending) return Promise.reject(new Error("The pending chat message is no longer available"));
    return this.sendChatMessage({ text: pending.text, attachments: pending.attachments });
  };
  readonly loadOlderChatMessages = () => this.#client.chat.loadOlder();
  readonly markChatRead = (throughSequence?: string): Promise<ChatReadReceipt | null> => {
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

export function toSpaceClientStore(client: SpaceClientStoreInput): SpaceClientStore {
  return "media" in client ? new SpaceClientAdapter(client) : client;
}

export type SpacePhase = "prejoin" | "joining" | "waiting" | "active" | "reconnecting" | "ended";
export type SpacePhaseInput = {
  readonly snapshot: Pick<SpaceSnapshotView, "connectionStatus" | "failure">;
  readonly hasAskedToJoin: boolean;
  readonly hasAskedToLeave: boolean;
};

export function deriveSpacePhase(input: SpacePhaseInput): SpacePhase {
  if (input.hasAskedToLeave || input.snapshot.failure?.code === "episode.ended") return "ended";
  if (input.snapshot.connectionStatus === "idle") return input.hasAskedToJoin ? "joining" : "prejoin";
  if (input.snapshot.connectionStatus === "joining") return "joining";
  if (input.snapshot.connectionStatus === "live") return "active";
  if (input.snapshot.connectionStatus === "reconnecting") return "reconnecting";
  return "ended";
}

function toSpaceSnapshot(snapshot: SpaceSnapshot): SpaceSnapshotView {
  return {
    connectionStatus: snapshot.connection.status,
    self: snapshot.self.participantId ? { participantId: snapshot.self.participantId } : null,
    participants: snapshot.participants.roster,
    admissionRequests: snapshot.participants.admissionQueue,
    localMedia: snapshot.media.local,
    remoteMedia: snapshot.media.remote,
    failure: snapshot.connection.lastError,
    capabilities: snapshot.self.capabilities,
    participantMediaById: Object.fromEntries(snapshot.participants.roster.map((participant) => [participant.participantId, participant.media])),
    reactions: snapshot.reactions.active,
    chat: snapshot.chat,
    incomingMediaRequests: snapshot.media.incomingRequests,
  };
}
