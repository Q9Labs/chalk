import type { TelemetryClientOptions } from "../telemetry/client";
import type { MediaSource } from "../media/plane";
import type { ChalkChatAttachment, ChalkChatMessage, ChalkChatPageResult, ChalkChatReadReceipt, ChalkDirectedRequestResult, ChalkIncomingMediaRequest, ChalkParticipantMediaState, ChalkReaction, ChalkReactionEvent } from "../collaboration/types";
import type { ChalkWhiteboardV1Failure, ChalkWhiteboardV1Transport } from "../whiteboard/types";
import type { AccessGrant } from "../session/access-grant";

export type AccessReason = "join" | "refresh" | "retry";

export type AccessContext = {
  readonly space: string;
  readonly reason: AccessReason;
};

export type GetAccess = (context: AccessContext) => Promise<AccessGrant>;

export type Logger = {
  readonly debug?: (message: string, attributes?: Readonly<Record<string, unknown>>) => void;
  readonly info?: (message: string, attributes?: Readonly<Record<string, unknown>>) => void;
  readonly warn?: (message: string, attributes?: Readonly<Record<string, unknown>>) => void;
  readonly error?: (message: string, attributes?: Readonly<Record<string, unknown>>) => void;
};

export type SpaceClientOptions = {
  readonly space: string;
  readonly getAccess: GetAccess;
  readonly baseUrl?: string;
  readonly logger?: Logger;
  readonly telemetry?: TelemetryClientOptions;
};

export type JoinOptions = {
  readonly displayName?: string;
  readonly microphone?: boolean;
  readonly camera?: boolean;
};

export type ConnectionStatus = "idle" | "joining" | "live" | "reconnecting" | "leaving" | "left" | "failed";

export type Capability =
  | "publishAudio"
  | "publishVideo"
  | "publishScreen"
  | "subscribe"
  | "raiseHand"
  | "renameSelf"
  | "sendChat"
  | "sendReaction"
  | "drawWhiteboard"
  | "manageWhiteboard"
  | "manageAdmission"
  | "assignRoles"
  | "muteOthers"
  | "stopVideoOthers"
  | "stopScreenOthers"
  | "requestMediaOthers"
  | "removeParticipant"
  | "startEpisode"
  | "extendEpisode"
  | "endEpisode"
  | "manageMembers"
  | "clearSpaceContent";

export type ErrorCode =
  | "access.invalid"
  | "access.unavailable"
  | "chat.cursor_reset_required"
  | "chat.payload_invalid"
  | "client.internal_error"
  | "collaboration.unavailable"
  | "command.rate_limited"
  | "command.rejected"
  | "connection.invalid_state"
  | "connection.join_cleanup_unconfirmed"
  | "connection.leave_unconfirmed"
  | "connection.media_recovery_exhausted"
  | "connection.media_start_failed"
  | "connection.sync_recovery_exhausted"
  | "connection.sync_start_failed"
  | "environment.unsupported"
  | "episode.ended"
  | "media.permission_denied"
  | "media.request_invalid"
  | "participant.invalid"
  | "reaction.invalid"
  | "whiteboard.unavailable";

export type ClientFailure = {
  readonly code: ErrorCode;
  readonly recoverable: boolean;
  readonly message: string;
};

export type EpisodeSummary = {
  readonly id: string;
  readonly startedAt: string | null;
  readonly deadline: string | null;
};

export type ConnectionSlice = {
  readonly status: ConnectionStatus;
  readonly episode: EpisodeSummary | null;
  readonly lastError: ClientFailure | null;
};

export type SelfSlice = {
  readonly participantId: string | null;
  readonly displayName: string | null;
  readonly role: string | null;
  readonly capabilities: readonly Capability[];
  readonly handRaised: boolean;
  readonly can: (capability: Capability) => boolean;
};

export type Participant = {
  readonly participantId: string;
  readonly displayName: string;
  readonly role: string;
  readonly eligibleRoles: readonly string[];
  readonly capabilities: readonly Capability[];
  readonly handRaised: boolean;
  readonly media: ChalkParticipantMediaState;
};

export type AdmissionRequest = {
  readonly requestId: string;
  readonly participantId: string;
  readonly displayName: string;
  readonly initialRole: string;
  readonly eligibleRoles: readonly string[];
  readonly expiresAt: string;
};

export type ParticipantsSlice = {
  readonly roster: readonly Participant[];
  readonly admissionQueue: readonly AdmissionRequest[];
};

export type MediaDevice = { readonly deviceId: string; readonly label: string };
export type LocalMedia = { readonly source: MediaSource; readonly state: "unavailable" | "requesting" | "enabled" | "disabled" | "failed"; readonly track: MediaStreamTrack | null };
export type RemoteMedia = { readonly participantId: string; readonly source: MediaSource; readonly publicationId: string; readonly track: MediaStreamTrack };
export type IncomingMediaRequest = ChalkIncomingMediaRequest;

export type MediaSlice = {
  readonly devices: {
    readonly microphones: readonly MediaDevice[];
    readonly cameras: readonly MediaDevice[];
    readonly speakers: readonly MediaDevice[];
  };
  readonly selection: {
    readonly microphone: string | null;
    readonly camera: string | null;
    readonly speaker: string | null;
  };
  readonly local: Readonly<Record<MediaSource, LocalMedia>>;
  readonly remote: readonly RemoteMedia[];
  readonly screenShare: LocalMedia;
  readonly incomingRequests: readonly IncomingMediaRequest[];
};

export type ChatAttachment = ChalkChatAttachment;
export type ChatMessage = ChalkChatMessage;
export type ChatReadReceipt = ChalkChatReadReceipt;
export type PendingChatSend = {
  readonly clientMessageId: string;
  readonly text: string;
  readonly attachments: readonly ChatAttachment[];
  readonly status: "sending" | "failed";
  readonly error: ClientFailure | null;
};

export type ChatSlice = {
  readonly status: "idle" | "loading" | "ready" | "failed";
  readonly messages: readonly ChatMessage[];
  readonly pendingSends: readonly PendingChatSend[];
  readonly readReceipts: readonly ChatReadReceipt[];
  readonly unreadCount: number;
  readonly pagination: {
    readonly cursor: string | null;
    readonly hasOlder: boolean;
    readonly historyTruncated: boolean;
  };
  readonly lastError: ClientFailure | null;
};

export type Reaction = ChalkReaction;
export type ActiveReaction = ChalkReactionEvent;
export type ReactionsSlice = { readonly active: readonly ActiveReaction[] };

export type WhiteboardSlice = {
  readonly open: boolean;
  readonly engine: {
    readonly status: "unsubscribed" | "loading" | "ready" | "recovering" | "failed";
    readonly sceneId: string | null;
    readonly revision: string | null;
    readonly error: ChalkWhiteboardV1Failure | null;
  };
};

export type SpaceSnapshot = {
  readonly connection: ConnectionSlice;
  readonly self: SelfSlice;
  readonly participants: ParticipantsSlice;
  readonly media: MediaSlice;
  readonly chat: ChatSlice;
  readonly reactions: ReactionsSlice;
  readonly whiteboard: WhiteboardSlice;
};

export type ChatSendInput = { readonly text: string; readonly attachments?: readonly ChatAttachment[] };
export type MediaRequestKind = "microphone" | "camera";
export type ChatUploadFile = { readonly name: string; readonly type: string; readonly size: number; readonly arrayBuffer: () => Promise<ArrayBuffer> } | { readonly fileName: string; readonly mimeType: string; readonly bytes: ArrayBuffer };

export type MediaController = {
  readonly setMicrophoneEnabled: (enabled: boolean) => Promise<void>;
  readonly setCameraEnabled: (enabled: boolean) => Promise<void>;
  readonly setScreenShareEnabled: (enabled: boolean) => Promise<void>;
  readonly selectMicrophone: (deviceId: string) => Promise<void>;
  readonly selectCamera: (deviceId: string) => Promise<void>;
  readonly selectSpeaker: (deviceId: string) => Promise<void>;
  readonly acceptRequest: (requestId: string) => Promise<void>;
  readonly declineRequest: (requestId: string) => Promise<void>;
};

export type ChatFilesController = {
  readonly upload: (file: ChatUploadFile) => Promise<ChatAttachment>;
  readonly url: (attachment: ChatAttachment) => string;
};

export type ChatController = {
  readonly files: ChatFilesController;
  readonly send: (input: ChatSendInput) => Promise<ChatMessage>;
  readonly loadOlder: () => Promise<ChalkChatPageResult>;
  readonly markRead: (messageId: string) => Promise<ChatReadReceipt | null>;
};

export type ParticipantsController = {
  readonly assignRole: (participantId: string, roleName: string) => Promise<void>;
  readonly mute: (participantId: string) => Promise<void>;
  readonly stopVideo: (participantId: string) => Promise<void>;
  readonly stopScreenShare: (participantId: string) => Promise<void>;
  readonly requestMedia: (participantId: string, kind: MediaRequestKind) => Promise<ChalkDirectedRequestResult>;
  readonly remove: (participantId: string) => Promise<void>;
  readonly admit: (requestId: string) => Promise<void>;
  readonly deny: (requestId: string) => Promise<void>;
  readonly raiseHand: () => Promise<void>;
  readonly lowerHand: () => Promise<void>;
  readonly renameSelf: (displayName: string) => Promise<void>;
};

export type ReactionsController = { readonly send: (emoji: Reaction) => Promise<ActiveReaction> };
export type WhiteboardController = { readonly transport: () => ChalkWhiteboardV1Transport | null };

export type ClientEventMap = {
  readonly participantJoined: { readonly participant: Participant };
  readonly participantLeft: { readonly participant: Participant };
  readonly episodeEnded: { readonly episode: EpisodeSummary | null };
  readonly screenShareStarted: { readonly participantId: string };
  readonly screenShareStopped: { readonly participantId: string };
  readonly error: { readonly error: import("./errors").SpaceClientError };
};

export type ClientEventName = keyof ClientEventMap;
export type ClientEventHandler<TEvent extends ClientEventName> = (event: ClientEventMap[TEvent]) => void;

export type SpaceClient = {
  readonly media: MediaController;
  readonly chat: ChatController;
  readonly participants: ParticipantsController;
  readonly reactions: ReactionsController;
  readonly whiteboard: WhiteboardController;
  readonly join: (options?: JoinOptions) => Promise<void>;
  readonly leave: () => Promise<void>;
  readonly dispose: () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => SpaceSnapshot;
  readonly endEpisode: () => Promise<void>;
  readonly extendEpisode: (minutes: number) => Promise<void>;
  readonly on: <TEvent extends ClientEventName>(event: TEvent, handler: ClientEventHandler<TEvent>) => () => void;
};
