const CONNECTION_STATES = ["idle", "joining", "live", "reconnecting", "leaving", "left", "failed"] as const;

export type ConnectionState = (typeof CONNECTION_STATES)[number];

const CONNECTION_ACTIONS = [
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

const CONNECTION_ERROR_CODES = [
  "invalid_state",
  "invalid_access",
  "access_unavailable",
  "permission_denied",
  "device_not_found",
  "device_busy",
  "device_constraint_invalid",
  "media_capture_failed",
  "sync_start_failed",
  "state_digest_recovery_failed",
  "sync_hello_timeout",
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
  readonly sync?: import("../sync/connect-diagnostics").SyncConnectDiagnostic;
};

export class ConnectionError extends Error {
  readonly code: ConnectionErrorCode;
  readonly action: ConnectionActionName | null;
  readonly recoverable: boolean;

  readonly sync?: import("../sync/connect-diagnostics").SyncConnectDiagnostic;

  constructor(failure: ConnectionFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = "ConnectionError";
    this.code = failure.code;
    this.action = failure.action;
    this.recoverable = failure.recoverable;
    this.sync = failure.sync;
  }
}

export type ConnectionConnectionPhase = "idle" | "connecting" | "healthy" | "unresponsive" | "recovering" | "failed" | "stopped";
