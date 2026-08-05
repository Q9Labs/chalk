import type { SyncV1ServerFrame } from "../generated/sync";
import type { JourneyTelemetryContext } from "../telemetry/types";
import type { ClientMediaPlane, MediaPlaneOutcome, MediaPlaneResult, MediaPlaneTarget, MediaPublication, MediaSource } from "../media/plane";
import type { ChalkChatMessage, ChalkChatPageResult, ChalkChatReadReceipt, ChalkReaction, ChalkReactionEvent, ChalkSendChatMessageInput, ChalkSyncV1CollaborationCapability } from "../collaboration/types";
import type { SyncClock, SyncIdGenerator, SyncLifecycle, SyncSocket, SyncWebSocketFactory } from "./types";

export type V1Capability =
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
  | "manageRecording"
  | "startEpisode"
  | "extendEpisode"
  | "endEpisode"
  | "manageMembers"
  | "clearSpaceContent";

// Roles are customer-defined; the wire accepts any non-empty role name.
export type V1Role = string;
export type V1AssignableRole = string;
export type V1AdmissionPolicy = "open" | "knock" | "members_only";
export type V1MediaSource = MediaSource;
export type V1ConnectionPhase = "idle" | "connecting" | "recovering" | "live" | "terminal" | "stopped";

export type V1Participant = {
  readonly participantId: string;
  readonly displayName: string;
  readonly handRaised: boolean;
  readonly admissionRevision: number;
  readonly role: V1Role;
  readonly eligibleRoles: readonly V1Role[];
  readonly capabilities: readonly V1Capability[];
};

export type V1AdmissionRequest = {
  readonly admissionRequestId: string;
  readonly participantId: string;
  readonly displayName: string;
  readonly initialRole: V1Role;
  readonly eligibleRoles: readonly V1Role[];
  readonly expiresAtMs: number;
};

export type V1Recording = {
  readonly recordingId: string;
  readonly status: "starting" | "recording" | "stopping" | "stopped" | "failed";
  readonly failureCode: string | null;
};

export type V1ControlState = {
  readonly revision: number;
  readonly stateSchemaVersion: number;
  readonly stateDigest: string;
  readonly status: "active" | "ended";
  readonly admissionPolicy: V1AdmissionPolicy;
  readonly deadlineAtMs: number;
  readonly deadlineGeneration: number;
  readonly roleCapabilities: Readonly<Record<string, readonly V1Capability[]>>;
  readonly recording: V1Recording | null;
  readonly participants: readonly V1Participant[];
  readonly admissionRequests: readonly V1AdmissionRequest[];
};

export type V1MediaPublication = MediaPublication;

export type V1Presence = {
  readonly participantId: string;
  readonly state: "connected" | "disconnected";
  readonly speaking: boolean;
  readonly activeSpeaker: boolean;
};

export type V1Projection<T> = { readonly projectionId: string; readonly sequence: number; readonly items: readonly T[] };

export type V1MediaPlaneOutcome = MediaPlaneOutcome;
export type V1MediaPlaneTarget = MediaPlaneTarget;
export type V1MediaPlaneResult = MediaPlaneResult;
export type V1ClientMediaPlane = ClientMediaPlane;

export type V1SelfMediaTargetResult = {
  readonly operationId: string;
  readonly name: "set_microphone_enabled" | "set_camera_enabled" | "set_screen_share_enabled";
  readonly serverOutcome: "confirmed" | "satisfied";
  readonly mediaPlaneOutcome: "confirmed" | "satisfied";
};

export type V1EpisodeSnapshot = {
  readonly connection: { readonly phase: V1ConnectionPhase; readonly terminalReason?: string };
  readonly participantId: string | null;
  readonly participantGeneration: number | null;
  readonly control: V1ControlState | null;
  readonly optimisticControl: V1ControlState | null;
  readonly media: V1Projection<V1MediaPublication> | null;
  readonly presence: V1Projection<V1Presence> | null;
  readonly mediaPlane: { readonly local: readonly V1MediaPublication[]; readonly remote: readonly V1MediaPublication[] };
  readonly localMedia: Readonly<Record<V1MediaSource, "unknown" | "requesting" | "enabled" | "disabled" | "failed">>;
  readonly pendingCommandCount: number;
};

export type V1TargetCommand =
  | { readonly name: "set_hand_raised"; readonly payload: { readonly raised: boolean } }
  | { readonly name: "set_display_name"; readonly payload: { readonly display_name: string } }
  | { readonly name: "set_admission_policy"; readonly payload: { readonly policy: V1AdmissionPolicy } }
  | { readonly name: "assign_roles"; readonly payload: { readonly participant_id: string; readonly role: V1AssignableRole } };

export type V1OperationName = "admit_participant" | "deny_admission" | "mute_participant" | "stop_participant_camera" | "stop_participant_screen_share" | "remove_participant" | "start_recording" | "stop_recording" | "participant_leave" | "start_episode" | "extend_episode" | "end_episode";

export type V1PendingTarget = { readonly commandId: string; readonly command: V1TargetCommand; readonly createdAt: number; readonly bytes: number };

export type V1PendingTargetStore = {
  load(): Promise<readonly V1PendingTarget[]>;
  put(command: V1PendingTarget): Promise<void>;
  remove(commandId: string): Promise<void>;
};

export type V1CommandResult = Extract<SyncV1ServerFrame, { readonly type: "ack" }>;
export type V1LiveTargetResult = Extract<SyncV1ServerFrame, { readonly type: "live_target_result" }>;
export type V1DirectedRequestResult = Extract<SyncV1ServerFrame, { readonly type: "directed_request_result" }>;
export type V1DirectedRequest = Extract<SyncV1ServerFrame, { readonly type: "directed_request" }>;

export type V1ChatCursor = {
  readonly afterSequence: string | null;
  readonly retainedFloorSequence: string | null;
};

export type V1CollaborationExtensionRequest = {
  readonly name: "collaboration_v1";
  readonly chatCursor: V1ChatCursor;
};

export type V1CollaborationExtensionState = {
  readonly negotiated: boolean;
  readonly version: 1 | null;
  readonly capabilities: readonly ChalkSyncV1CollaborationCapability[];
  readonly chatHeadSequence: string | null;
  readonly retainedFloorSequence: string | null;
  readonly readReceipts: readonly ChalkChatReadReceipt[];
};

export type V1CollaborationEvent =
  | { readonly type: "reaction"; readonly reaction: ChalkReactionEvent }
  | { readonly type: "chat_message"; readonly message: ChalkChatMessage }
  | { readonly type: "chat_read_receipt"; readonly receipt: ChalkChatReadReceipt }
  | { readonly type: "chat_cursor_reset"; readonly retainedFloorSequence: string };

export type V1CollaborationClient = {
  readonly getCollaborationExtensionState: () => V1CollaborationExtensionState;
  readonly getParticipantCollaborationCapabilities: () => Readonly<Record<string, readonly ChalkSyncV1CollaborationCapability[]>>;
  readonly subscribeCollaboration: (listener: (event: V1CollaborationEvent) => void) => () => void;
  readonly sendReaction: (reaction: ChalkReaction) => Promise<ChalkReactionEvent>;
  readonly sendChatMessage: (input: ChalkSendChatMessageInput) => Promise<ChalkChatMessage>;
  readonly markChatRead: (sequence: string) => Promise<ChalkChatReadReceipt>;
  readonly readChatPage: (input: { readonly beforeSequence?: string; readonly afterSequence?: string; readonly limit: number }) => Promise<ChalkChatPageResult>;
};

export type V1SyncClientOptions = {
  readonly url: string;
  readonly token: () => Promise<string>;
  readonly webSocket: SyncWebSocketFactory;
  readonly pendingStore?: V1PendingTargetStore;
  readonly mediaPlane?: V1ClientMediaPlane;
  readonly ids?: SyncIdGenerator;
  readonly requestIds?: SyncIdGenerator;
  readonly clock?: SyncClock;
  readonly lifecycle?: SyncLifecycle;
  readonly reconnectDelayMs?: number;
  readonly maxPendingCommands?: number;
  readonly maxPendingBytes?: number;
  readonly maxPendingAgeMs?: number;
  readonly maxOperationPendingAgeMs?: number;
  readonly retryDelayMs?: number;
  readonly collaboration?: V1CollaborationExtensionRequest | false;
  readonly telemetry?: JourneyTelemetryContext;
  readonly maxPendingCollaborationRequests?: number;
};

export type V1Socket = SyncSocket;
