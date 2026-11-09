import { expectTypeOf, it } from "vitest";
import type { ErrorCode } from "../index";

// Existing consumers exhaustively handle this published set of error codes.
type ExistingErrorCode =
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
  | "connection.state_digest_recovery_failed"
  | "connection.sync_recovery_exhausted"
  | "connection.sync_start_failed"
  | "connection.sync_hello_timeout"
  | "environment.unsupported"
  | "episode.ended"
  | "media.permission_denied"
  | "media.device_not_found"
  | "media.device_busy"
  | "media.device_constraint_invalid"
  | "media.capture_failed"
  | "media.request_invalid"
  | "media.timeout"
  | "offline.discarded"
  | "participant.invalid"
  | "reaction.invalid"
  | "whiteboard.unavailable";

it("keeps existing exhaustive ErrorCode consumers compiling", () => {
  expectTypeOf<ErrorCode>().toEqualTypeOf<ExistingErrorCode>();
});
