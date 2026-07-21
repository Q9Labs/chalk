import type { ParticipantAccessSubject } from "./access";

export const CHALK_SESSION_STATES = ["idle", "joining", "live", "reconnecting", "leaving", "left", "failed"] as const;

export type ChalkSessionState = (typeof CHALK_SESSION_STATES)[number];

export const CHALK_SESSION_ACTIONS = [
  "join",
  "leave",
  "setMicrophoneEnabled",
  "setCameraEnabled",
  "startScreenShare",
  "stopScreenShare",
  "setHandRaised",
  "setDisplayName",
  "setAdmissionPolicy",
  "setParticipantRole",
  "transferHost",
  "admitParticipant",
  "denyAdmission",
  "muteParticipant",
  "stopParticipantCamera",
  "stopParticipantScreenShare",
  "removeParticipant",
  "endSession",
] as const;

export type ChalkSessionActionName = (typeof CHALK_SESSION_ACTIONS)[number];

export const CHALK_SESSION_ERROR_CODES = [
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
  "session_ended",
  "unsupported_environment",
  "internal_error",
] as const;

export type ChalkSessionErrorCode = (typeof CHALK_SESSION_ERROR_CODES)[number];

export type ChalkSessionFailure = {
  readonly code: ChalkSessionErrorCode;
  readonly action: ChalkSessionActionName | null;
  readonly recoverable: boolean;
  readonly message: string;
};

export class ChalkSessionError extends Error {
  readonly code: ChalkSessionErrorCode;
  readonly action: ChalkSessionActionName | null;
  readonly recoverable: boolean;

  constructor(failure: ChalkSessionFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = "ChalkSessionError";
    this.code = failure.code;
    this.action = failure.action;
    this.recoverable = failure.recoverable;
  }
}

export type ChalkSessionConnectionPhase = "idle" | "connecting" | "healthy" | "recovering" | "failed" | "stopped";
export type ChalkMediaSource = "microphone" | "camera" | "screen";
export type ChalkParticipantRole = "host" | "cohost" | "participant";
export type ChalkAssignableParticipantRole = Exclude<ChalkParticipantRole, "host">;
export type ChalkAdmissionPolicy = "open" | "approval" | "closed";

export type ChalkSessionCapability =
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
  | "endMeeting";

export type ChalkParticipant = {
  readonly participantSessionId: string;
  readonly displayName: string;
  readonly handRaised: boolean;
  readonly role: ChalkParticipantRole;
  readonly eligibleRoles: readonly ChalkParticipantRole[];
  readonly capabilities: readonly ChalkSessionCapability[];
};

export type ChalkAdmissionRequest = {
  readonly admissionRequestId: string;
  readonly participantSessionId: string;
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
  readonly participantSessionId: string;
  readonly source: ChalkMediaSource;
  readonly publicationId: string;
  readonly track: MediaStreamTrack;
};

export type ChalkSessionSnapshot = {
  readonly state: ChalkSessionState;
  readonly subject: ParticipantAccessSubject | null;
  readonly connection: {
    readonly sync: ChalkSessionConnectionPhase;
    readonly media: ChalkSessionConnectionPhase;
  };
  readonly admissionPolicy: ChalkAdmissionPolicy | null;
  readonly participants: readonly ChalkParticipant[];
  readonly admissionRequests: readonly ChalkAdmissionRequest[];
  readonly localMedia: Readonly<Record<ChalkMediaSource, ChalkLocalMedia>>;
  readonly remoteMedia: readonly ChalkRemoteMedia[];
  readonly failure: ChalkSessionFailure | null;
};

export type ChalkSessionActions = {
  readonly join: () => Promise<void>;
  readonly leave: () => Promise<void>;
  readonly setMicrophoneEnabled: (enabled: boolean) => Promise<void>;
  readonly setCameraEnabled: (enabled: boolean) => Promise<void>;
  readonly startScreenShare: () => Promise<void>;
  readonly stopScreenShare: () => Promise<void>;
  readonly setHandRaised: (raised: boolean) => Promise<void>;
  readonly setDisplayName: (displayName: string) => Promise<void>;
  readonly setAdmissionPolicy: (policy: ChalkAdmissionPolicy) => Promise<void>;
  readonly setParticipantRole: (participantSessionId: string, role: ChalkAssignableParticipantRole) => Promise<void>;
  readonly transferHost: (participantSessionId: string) => Promise<void>;
  readonly admitParticipant: (admissionRequestId: string) => Promise<void>;
  readonly denyAdmission: (admissionRequestId: string) => Promise<void>;
  readonly muteParticipant: (participantSessionId: string) => Promise<void>;
  readonly stopParticipantCamera: (participantSessionId: string) => Promise<void>;
  readonly stopParticipantScreenShare: (participantSessionId: string) => Promise<void>;
  readonly removeParticipant: (participantSessionId: string) => Promise<void>;
  readonly endSession: () => Promise<void>;
};

export type ChalkSessionStore = ChalkSessionActions & {
  readonly getSnapshot: () => ChalkSessionSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
};
