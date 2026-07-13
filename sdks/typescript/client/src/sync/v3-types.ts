import type { SyncV3ServerFrame } from "../generated/sync-v3";
import type { SyncClock, SyncIdGenerator, SyncLifecycle, SyncSocket, SyncWebSocketFactory } from "./types";

export type V3Capability =
  | "publishAudio"
  | "publishVideo"
  | "publishScreen"
  | "subscribe"
  | "raiseHand"
  | "renameSelf"
  | "manageAdmission"
  | "promoteDemote"
  | "transferHost"
  | "muteOthers"
  | "stopVideoOthers"
  | "stopScreenOthers"
  | "requestMediaOthers"
  | "removeParticipant"
  | "manageRecording"
  | "endMeeting";

export type V3Role = "host" | "cohost" | "participant";
export type V3AssignableRole = Exclude<V3Role, "host">;
export type V3AdmissionPolicy = "open" | "approval" | "closed";
export type V3MediaSource = "microphone" | "camera" | "screen";
export type V3ConnectionPhase = "idle" | "connecting" | "recovering" | "live" | "terminal" | "stopped";

export type V3Participant = {
  readonly participantSessionId: string;
  readonly displayName: string;
  readonly handRaised: boolean;
  readonly admissionRevision: number;
  readonly role: V3Role;
  readonly eligibleRoles: readonly V3Role[];
  readonly capabilities: readonly V3Capability[];
};

export type V3AdmissionRequest = {
  readonly admissionRequestId: string;
  readonly participantSessionId: string;
  readonly displayName: string;
  readonly initialRole: V3Role;
  readonly eligibleRoles: readonly V3Role[];
  readonly expiresAtMs: number;
};

export type V3Recording = {
  readonly recordingId: string;
  readonly status: "starting" | "recording" | "stopping" | "stopped" | "failed";
  readonly failureCode: string | null;
};

export type V3ControlState = {
  readonly revision: number;
  readonly stateSchemaVersion: number;
  readonly stateDigest: string;
  readonly status: "active" | "ended";
  readonly admissionPolicy: V3AdmissionPolicy;
  readonly hostExitPolicy: "require_transfer" | "promote_cohost";
  readonly hostParticipantSessionId: string | null;
  readonly deadlineAtMs: number;
  readonly deadlineGeneration: number;
  readonly roleCapabilities: Readonly<Record<V3Role, readonly V3Capability[]>>;
  readonly recording: V3Recording | null;
  readonly participants: readonly V3Participant[];
  readonly admissionRequests: readonly V3AdmissionRequest[];
};

export type V3MediaPublication = {
  readonly participantSessionId: string;
  readonly source: V3MediaSource;
  readonly enabled: boolean;
  readonly publicationId: string | null;
};

export type V3Presence = {
  readonly participantSessionId: string;
  readonly state: "connected" | "disconnected";
  readonly speaking: boolean;
  readonly activeSpeaker: boolean;
};

export type V3Projection<T> = { readonly projectionId: string; readonly sequence: number; readonly items: readonly T[] };

export type V3MediaPlaneOutcome = "confirmed" | "satisfied" | "retryable_failure" | "terminal_failure" | "ambiguous";

export type V3MediaPlaneTarget = {
  readonly operationId: string;
  readonly participantSessionId: string;
  readonly source: V3MediaSource;
  readonly enabled: boolean;
};

export type V3MediaPlaneResult = {
  readonly outcome: V3MediaPlaneOutcome;
  readonly errorCode: string | null;
};

export type V3ClientMediaPlane = {
  readonly setLocalPublicationTarget: (target: V3MediaPlaneTarget) => Promise<V3MediaPlaneResult>;
  readonly observeLocalPublications: (listener: (publications: readonly V3MediaPublication[]) => void) => () => void;
  readonly observeRemotePublications: (listener: (publications: readonly V3MediaPublication[]) => void) => () => void;
};

export type V3SelfMediaTargetResult = {
  readonly operationId: string;
  readonly name: "set_microphone_enabled" | "set_camera_enabled" | "set_screen_share_enabled";
  readonly serverOutcome: "confirmed" | "satisfied";
  readonly mediaPlaneOutcome: "confirmed" | "satisfied";
};

export type V3SessionSnapshot = {
  readonly connection: { readonly phase: V3ConnectionPhase; readonly terminalReason?: string };
  readonly participantSessionId: string | null;
  readonly participantSessionGeneration: number | null;
  readonly control: V3ControlState | null;
  readonly optimisticControl: V3ControlState | null;
  readonly media: V3Projection<V3MediaPublication> | null;
  readonly presence: V3Projection<V3Presence> | null;
  readonly mediaPlane: { readonly local: readonly V3MediaPublication[]; readonly remote: readonly V3MediaPublication[] };
  readonly localMedia: Readonly<Record<V3MediaSource, "unknown" | "requesting" | "enabled" | "disabled" | "failed">>;
  readonly pendingCommandCount: number;
};

export type V3TargetCommand =
  | { readonly name: "set_hand_raised"; readonly payload: { readonly raised: boolean } }
  | { readonly name: "set_display_name"; readonly payload: { readonly display_name: string } }
  | { readonly name: "set_admission_policy"; readonly payload: { readonly policy: V3AdmissionPolicy } }
  | { readonly name: "set_participant_role"; readonly payload: { readonly participant_session_id: string; readonly role: V3AssignableRole } }
  | { readonly name: "transfer_host"; readonly payload: { readonly participant_session_id: string } };

export type V3OperationName = "admit_participant" | "deny_admission" | "mute_participant" | "stop_participant_camera" | "stop_participant_screen_share" | "remove_participant" | "start_recording" | "stop_recording" | "participant_leave" | "end_session";

export type V3PendingTarget = { readonly commandId: string; readonly command: V3TargetCommand; readonly createdAt: number; readonly bytes: number };

export type V3PendingTargetStore = {
  load(): Promise<readonly V3PendingTarget[]>;
  put(command: V3PendingTarget): Promise<void>;
  remove(commandId: string): Promise<void>;
};

export type V3CommandResult = Extract<SyncV3ServerFrame, { readonly type: "ack" }>;
export type V3LiveTargetResult = Extract<SyncV3ServerFrame, { readonly type: "live_target_result" }>;
export type V3DirectedRequestResult = Extract<SyncV3ServerFrame, { readonly type: "directed_request_result" }>;
export type V3DirectedRequest = Extract<SyncV3ServerFrame, { readonly type: "directed_request" }>;

export type V3SyncClientOptions = {
  readonly url: string;
  readonly token: () => Promise<string>;
  readonly webSocket: SyncWebSocketFactory;
  readonly pendingStore?: V3PendingTargetStore;
  readonly mediaPlane?: V3ClientMediaPlane;
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
};

export type V3Socket = SyncSocket;
