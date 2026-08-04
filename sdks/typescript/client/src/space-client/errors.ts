import { Data } from "effect";
import type { ConnectionError } from "../connection/types";
import type { ClientFailure, ErrorCode } from "./types";

export class SpaceClientError extends Data.TaggedError("SpaceClientError")<ClientFailure> {}

const CONNECTION_ERROR_CODE_MAP = {
  invalid_access: "access.invalid",
  access_unavailable: "access.unavailable",
  permission_denied: "media.permission_denied",
  sync_start_failed: "connection.sync_start_failed",
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

export function normalizeClientError(cause: unknown, fallback: ErrorCode = "client.internal_error"): SpaceClientError {
  if (cause instanceof SpaceClientError) return cause;
  if (isConnectionError(cause)) {
    return new SpaceClientError({
      code: connectionErrorCode(cause.code, cause.action),
      recoverable: cause.recoverable,
      message: cause.message,
    });
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

function connectionErrorCode(code: ConnectionError["code"], action: ConnectionError["action"]): ErrorCode {
  if (code === "invalid_payload") return INVALID_PAYLOAD_CODE_BY_ACTION.get(action) ?? "participant.invalid";
  return CONNECTION_ERROR_CODE_MAP[code];
}
