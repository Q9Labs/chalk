import type { AccessSubject } from "../access/grant";
import type {
  ChalkChatMessage,
  ChalkChatPageResult,
  ChalkChatReadReceipt,
  ChalkChatStateSnapshot,
  ChalkCollaborationCapability,
  ChalkCollaborationPhase,
  ChalkDirectedRequestResult,
  ChalkIncomingMediaRequest,
  ChalkParticipantMediaState,
  ChalkPendingChatMessageState,
  ChalkReaction,
  ChalkReactionEvent,
  ChalkSendChatMessageInput,
  ChalkSyncV1CollaborationCapability,
} from "../collaboration/types";
import type { ChalkChatFileTransport } from "../chat-files/types";
import type { ChalkWhiteboardSummary, ChalkWhiteboardV1Transport } from "../whiteboard/types";

export { ChalkWhiteboardV1Error } from "../whiteboard/types";
export type {
  ChalkChatAttachment,
  ChalkChatMessage,
  ChalkChatPageResult,
  ChalkChatReadReceipt,
  ChalkCollaborationCapability,
  ChalkCollaborationPhase,
  ChalkDirectedRequestResult,
  ChalkIncomingMediaRequest,
  ChalkParticipantMediaState,
  ChalkReaction,
  ChalkReactionEvent,
  ChalkSendChatMessageInput,
  ChalkSyncV1CollaborationCapability,
} from "../collaboration/types";
export type {
  ChalkJsonValue,
  ChalkSharedWhiteboardAppState,
  ChalkWhiteboardSummary,
  ChalkWhiteboardV1Capability,
  ChalkWhiteboardV1Commit,
  ChalkWhiteboardV1Element,
  ChalkWhiteboardV1ErrorCode,
  ChalkWhiteboardV1Event,
  ChalkWhiteboardV1Failure,
  ChalkWhiteboardV1FileTransport,
  ChalkWhiteboardV1Operation,
  ChalkWhiteboardV1Transport,
  ChalkWhiteboardV1UpdateInput,
} from "../whiteboard/types";

export const CONNECTION_STATES = ["idle", "joining", "live", "reconnecting", "leaving", "left", "failed"] as const;

export type ConnectionState = (typeof CONNECTION_STATES)[number];

export const CONNECTION_ACTIONS = [
  "join",
  "leave",
  "setMicrophoneEnabled",
  "setCameraEnabled",
  "startScreenShare",
  "stopScreenShare",
  "setHandRaised",
  "setDisplayName",
  "setAdmissionPolicy",
  "assignRole",
  "admitParticipant",
  "denyAdmission",
  "muteParticipant",
  "stopParticipantCamera",
  "stopParticipantScreenShare",
  "removeParticipant",
  "endEpisode",
  "extendEpisode",
  "sendReaction",
  "sendChatMessage",
  "retryChatMessage",
  "loadOlderChatMessages",
  "markChatRead",
  "requestUnmute",
  "requestStartCamera",
  "acceptMediaRequest",
  "declineMediaRequest",
] as const;

export type ConnectionActionName = (typeof CONNECTION_ACTIONS)[number];

export const CONNECTION_ERROR_CODES = [
  "invalid_state",
  "invalid_access",
  "access_unavailable",
  "permission_denied",
  "sync_start_failed",
  "media_start_failed",
  "join_cleanup_unconfirmed",
  "sync_recovery_exhausted",
  "media_recovery_exhausted",
  "command_rejected",
  "leave_unconfirmed",
  "episode_ended",
  "unsupported_environment",
  "internal_error",
  "collaboration_unavailable",
  "chat_cursor_reset_required",
  "rate_limited",
  "invalid_payload",
] as const;

export type ConnectionErrorCode = (typeof CONNECTION_ERROR_CODES)[number];

export type ConnectionFailure = {
  readonly code: ConnectionErrorCode;
  readonly action: ConnectionActionName | null;
  readonly recoverable: boolean;
  readonly message: string;
};

export type ChalkPendingChatMessage = ChalkPendingChatMessageState<ConnectionFailure>;

export type ChalkChatState = ChalkChatStateSnapshot<ConnectionFailure, ChalkPendingChatMessage>;

export class ConnectionError extends Error {
  readonly code: ConnectionErrorCode;
  readonly action: ConnectionActionName | null;
  readonly recoverable: boolean;

  constructor(failure: ConnectionFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = "ConnectionError";
    this.code = failure.code;
    this.action = failure.action;
    this.recoverable = failure.recoverable;
  }
}

export type ConnectionConnectionPhase = "idle" | "connecting" | "healthy" | "recovering" | "failed" | "stopped";
export type ChalkMediaSource = "microphone" | "camera" | "screen";
export type ChalkParticipantRole = string;
export type ChalkAssignableParticipantRole = string;
export type ChalkAdmissionPolicy = "open" | "knock" | "members_only";

export type ConnectionCapability =
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

export type ChalkParticipant = {
  readonly participantId: string;
  readonly displayName: string;
  readonly handRaised: boolean;
  readonly role: ChalkParticipantRole;
  readonly eligibleRoles: readonly ChalkParticipantRole[];
  readonly capabilities: readonly ConnectionCapability[];
};

export type ChalkAdmissionRequest = {
  readonly admissionRequestId: string;
  readonly participantId: string;
  readonly displayName: string;
  readonly initialRole: ChalkParticipantRole;
  readonly eligibleRoles: readonly ChalkParticipantRole[];
  readonly expiresAt: string;
};

export type ChalkLocalMedia = {
  readonly source: ChalkMediaSource;
  readonly state: "unavailable" | "requesting" | "enabled" | "disabled" | "failed";
  readonly track: MediaStreamTrack | null;
};

export type ChalkRemoteMedia = {
  readonly participantId: string;
  readonly source: ChalkMediaSource;
  readonly publicationId: string;
  readonly track: MediaStreamTrack;
};

export type ConnectionSnapshot = {
  readonly state: ConnectionState;
  readonly subject: AccessSubject | null;
  readonly episode: { readonly id: string; readonly startedAt: string | null; readonly deadline: string | null } | null;
  readonly connection: {
    readonly sync: ConnectionConnectionPhase;
    readonly media: ConnectionConnectionPhase;
  };
  readonly admissionPolicy: ChalkAdmissionPolicy | null;
  readonly participants: readonly ChalkParticipant[];
  readonly admissionRequests: readonly ChalkAdmissionRequest[];
  readonly localMedia: Readonly<Record<ChalkMediaSource, ChalkLocalMedia>>;
  readonly remoteMedia: readonly ChalkRemoteMedia[];
  readonly failure: ConnectionFailure | null;
  readonly collaboration: {
    readonly phase: ChalkCollaborationPhase;
    readonly version: 1 | null;
    readonly capabilities: readonly ChalkSyncV1CollaborationCapability[];
    readonly error: ConnectionFailure | null;
  };
  readonly participantCollaborationCapabilities: Readonly<Record<string, readonly ChalkCollaborationCapability[]>>;
  readonly participantMedia: Readonly<Record<string, ChalkParticipantMediaState>>;
  readonly reactions: readonly ChalkReactionEvent[];
  readonly chat: ChalkChatState;
  readonly whiteboard: ChalkWhiteboardSummary;
  readonly incomingMediaRequests: readonly ChalkIncomingMediaRequest[];
};

export type ConnectionActions = {
  readonly join: () => Promise<void>;
  readonly leave: () => Promise<void>;
  readonly setMicrophoneEnabled: (enabled: boolean) => Promise<void>;
  readonly setCameraEnabled: (enabled: boolean) => Promise<void>;
  readonly startScreenShare: () => Promise<void>;
  readonly stopScreenShare: () => Promise<void>;
  readonly setHandRaised: (raised: boolean) => Promise<void>;
  readonly setDisplayName: (displayName: string) => Promise<void>;
  readonly setAdmissionPolicy: (policy: ChalkAdmissionPolicy) => Promise<void>;
  readonly assignRole: (participantId: string, role: ChalkAssignableParticipantRole) => Promise<void>;
  readonly admitParticipant: (admissionRequestId: string) => Promise<void>;
  readonly denyAdmission: (admissionRequestId: string) => Promise<void>;
  readonly muteParticipant: (participantId: string) => Promise<void>;
  readonly stopParticipantCamera: (participantId: string) => Promise<void>;
  readonly stopParticipantScreenShare: (participantId: string) => Promise<void>;
  readonly removeParticipant: (participantId: string) => Promise<void>;
  readonly endEpisode: () => Promise<void>;
  readonly extendEpisode: (minutes: number) => Promise<void>;
  readonly sendReaction: (reaction: ChalkReaction) => Promise<ChalkReactionEvent>;
  readonly sendChatMessage: (input: ChalkSendChatMessageInput) => Promise<ChalkChatMessage>;
  readonly retryChatMessage: (clientMessageId: string) => Promise<ChalkChatMessage>;
  readonly loadOlderChatMessages: (limit?: number) => Promise<ChalkChatPageResult>;
  readonly markChatRead: (throughSequence?: string) => Promise<ChalkChatReadReceipt | null>;
  readonly requestUnmute: (participantId: string) => Promise<ChalkDirectedRequestResult>;
  readonly requestStartCamera: (participantId: string) => Promise<ChalkDirectedRequestResult>;
  readonly acceptMediaRequest: (requestId: string) => Promise<void>;
  readonly declineMediaRequest: (requestId: string) => void;
};

export type ConnectionStore = ConnectionActions & {
  readonly getSnapshot: () => ConnectionSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly chatFiles: ChalkChatFileTransport | null;
  readonly whiteboard: ChalkWhiteboardV1Transport | null;
};
