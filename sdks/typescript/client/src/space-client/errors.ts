import { Data } from "effect";
import { ChalkChatFileError } from "../chat-files/types";
import { ConnectionLifecycleFailure } from "../connection/lifecycle";
import type { ConnectionError } from "../connection/types";
import { V1SyncError } from "../sync/v1-error";
import type { ClientFailure, ErrorCode } from "./types";

export class SpaceClientError extends Data.TaggedError("SpaceClientError")<ClientFailure> {}

const CONNECTION_ERROR_CODE_MAP = {
  invalid_access: "access.invalid",
  access_unavailable: "access.unavailable",
  permission_denied: "media.permission_denied",
  device_not_found: "media.device_not_found",
  device_busy: "media.device_busy",
  device_constraint_invalid: "media.device_constraint_invalid",
  media_capture_failed: "media.capture_failed",
  sync_start_failed: "connection.sync_start_failed",
  state_digest_recovery_failed: "connection.state_digest_recovery_failed",
  sync_hello_timeout: "connection.sync_hello_timeout",
  media_start_failed: "connection.media_start_failed",
  join_cleanup_unconfirmed: "connection.join_cleanup_unconfirmed",
  sync_recovery_exhausted: "connection.sync_recovery_exhausted",
  media_recovery_exhausted: "connection.media_recovery_exhausted",
  leave_unconfirmed: "connection.leave_unconfirmed",
  episode_ended: "episode.ended",
  unsupported_environment: "environment.unsupported",
  collaboration_unavailable: "collaboration.unavailable",
  chat_cursor_reset_required: "chat.cursor_reset_required",
  rate_limited: "command.rate_limited",
  command_rejected: "command.rejected",
  invalid_state: "connection.invalid_state",
  internal_error: "client.internal_error",
} as const satisfies Record<Exclude<ConnectionError["code"], "invalid_payload">, ErrorCode>;

const INVALID_PAYLOAD_CODE_BY_ACTION: ReadonlyMap<ConnectionError["action"], ErrorCode> = new Map([
  ["sendChatMessage", "chat.payload_invalid"],
  ["retryChatMessage", "chat.payload_invalid"],
  ["loadOlderChatMessages", "chat.payload_invalid"],
  ["markChatRead", "chat.payload_invalid"],
  ["acceptMediaRequest", "media.request_invalid"],
  ["declineMediaRequest", "media.request_invalid"],
]);

const MEDIA_TIMEOUT_FAILURE = { code: "media.timeout", recoverable: true, message: "Media did not respond in time. Try again." } as const;
const SYNC_FAILURES: ReadonlyMap<string, { readonly failure: ClientFailure; readonly scope?: "media" }> = new Map([
  ["not_live", { failure: { code: "connection.invalid_state", recoverable: true, message: "Wait for the call to connect, then try again." } }],
  ["signaling_timeout", { failure: MEDIA_TIMEOUT_FAILURE }],
  ["negotiation_timeout", { failure: MEDIA_TIMEOUT_FAILURE }],
  ["media_timeout", { failure: MEDIA_TIMEOUT_FAILURE }],
  ["retry_exhausted", { failure: MEDIA_TIMEOUT_FAILURE, scope: "media" }],
  ["reaction_ack_timeout", { failure: { code: "collaboration.unavailable", recoverable: true, message: "Couldn’t confirm your reaction. Try again." } }],
  ["overloaded", { failure: { code: "collaboration.unavailable", recoverable: true, message: "The call is busy right now. Try again." } }],
  ["rate_limited", { failure: { code: "command.rate_limited", recoverable: true, message: "You are sending messages too fast. Wait a moment, then try again." } }],
]);

export function normalizeMediaError(cause: unknown): SpaceClientError {
  return normalizeClientError(cause, "client.internal_error", "media");
}

export function normalizeClientError(cause: unknown, fallback: ErrorCode = "client.internal_error", scope?: "media"): SpaceClientError {
  if (cause instanceof SpaceClientError) return cause;
  if (cause instanceof ChalkChatFileError && cause.code === "unavailable") {
    return new SpaceClientError({ code: cause.stage === "token" ? "access.unavailable" : "collaboration.unavailable", recoverable: cause.recoverable, message: cause.message });
  }
  if (cause instanceof ConnectionLifecycleFailure || isConnectionError(cause)) {
    return new SpaceClientError({
      code: connectionErrorCode(cause.code, cause instanceof ConnectionLifecycleFailure ? null : cause.action),
      recoverable: cause.recoverable,
      message: cause.message,
    });
  }
  if (cause instanceof V1SyncError) {
    const policy = SYNC_FAILURES.get(cause.code);
    if (policy && (!policy.scope || policy.scope === scope)) return new SpaceClientError(policy.failure);
  }
  if (isAccessInvalid(cause)) {
    return new SpaceClientError({ code: "access.invalid", recoverable: true, message: "The access grant was rejected" });
  }
  const message = cause instanceof Error ? cause.message : "The client operation failed";
  return new SpaceClientError({ code: fallback, recoverable: false, message });
}

export function failureFromError(error: SpaceClientError): ClientFailure {
  return Object.freeze({ code: error.code, recoverable: error.recoverable, message: error.message });
}

export function isAccessInvalid(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return false;
  return cause.code === "access.invalid" || cause.code === "invalid_access";
}

function isConnectionError(cause: unknown): cause is ConnectionError {
  return cause instanceof Error && "code" in cause && "action" in cause && "recoverable" in cause;
}

export function connectionErrorCode(code: ConnectionError["code"], action: ConnectionError["action"]): ErrorCode {
  if (code === "invalid_payload") return INVALID_PAYLOAD_CODE_BY_ACTION.get(action) ?? "participant.invalid";
  return CONNECTION_ERROR_CODE_MAP[code];
}
