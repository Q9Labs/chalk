/**
 * Effect-based typed errors for Chalk SDK
 *
 * Maps to existing ChalkErrorCode enum but provides exhaustive pattern matching
 * via Effect's tagged errors.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect
 */

import { Data } from "effect";
import {
  ChalkError,
  ChalkErrorCode,
} from "../errors/chalk-error";

/**
 * Base interface for all SDK errors
 */
interface SDKErrorBase {
  readonly message: string;
  readonly recoverable: boolean;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

/**
 * Connection errors - network and WebSocket failures
 */
export class ConnectionError extends Data.TaggedError("ConnectionError")<SDKErrorBase & {
  readonly code: "CONNECTION_FAILED" | "CONNECTION_LOST" | "RECONNECT_FAILED" | "WEBSOCKET_ERROR";
}> {}

/**
 * Authentication errors - token and permission issues
 */
export class AuthError extends Data.TaggedError("AuthError")<SDKErrorBase & {
  readonly code: "AUTH_FAILED" | "TOKEN_EXPIRED" | "TOKEN_REFRESH_FAILED" | "INVALID_API_KEY" | "PERMISSION_DENIED";
  readonly tokenExpired?: boolean;
}> {}

/**
 * Media errors - camera, microphone, screen share failures
 */
export class MediaError extends Data.TaggedError("MediaError")<SDKErrorBase & {
  readonly code: "MEDIA_PERMISSION_DENIED" | "DEVICE_NOT_FOUND" | "DEVICE_IN_USE" | "SCREEN_SHARE_CANCELLED" | "SCREEN_SHARE_FAILED" | "OVERCONSTRAINED";
  readonly deviceId?: string;
}> {}

/**
 * ConferenceSession errors - lifecycle and state issues
 */
export class RoomError extends Data.TaggedError("RoomError")<SDKErrorBase & {
  readonly code: "ROOM_NOT_FOUND" | "ROOM_FULL" | "ALREADY_IN_ROOM" | "NOT_IN_ROOM" | "ROOM_ENDED";
  readonly roomId?: string;
}> {}

/**
 * Recording errors - recording lifecycle failures
 */
export class RecordingError extends Data.TaggedError("RecordingError")<SDKErrorBase & {
  readonly code: "RECORDING_FAILED" | "RECORDING_IN_PROGRESS" | "NO_ACTIVE_RECORDING";
  readonly recordingId?: string;
}> {}

/**
 * Generic errors - unknown, validation, rate limiting
 */
export class GenericError extends Data.TaggedError("GenericError")<SDKErrorBase & {
  readonly code: "UNKNOWN" | "INVALID_PARAMS" | "RATE_LIMITED" | "SERVER_ERROR";
}> {}

/**
 * Timeout error - operation exceeded time limit
 */
export class TimeoutError extends Data.TaggedError("TimeoutError")<{
  readonly message: string;
  readonly operation: string;
  readonly timeoutMs: number;
}> {}

/**
 * Parse error - invalid payload or schema validation failure
 */
export class ParseError extends Data.TaggedError("ParseError")<{
  readonly message: string;
  readonly input: unknown;
  readonly path?: string;
}> {}

/**
 * Union of all SDK errors for exhaustive matching
 */
export type SDKError =
  | ConnectionError
  | AuthError
  | MediaError
  | RoomError
  | RecordingError
  | GenericError
  | TimeoutError
  | ParseError;

/**
 * Convert SDK Error to legacy ChalkError for backwards compatibility
 */
export const toChalkError = (error: SDKError): ChalkError => {
  switch (error._tag) {
    case "ConnectionError":
      return new ChalkError(
        ChalkErrorCode[error.code],
        error.message,
        { recoverable: error.recoverable, details: error.details, cause: error.cause as Error | undefined }
      );

    case "AuthError":
      return new ChalkError(
        ChalkErrorCode[error.code],
        error.message,
        { recoverable: error.recoverable, details: error.details, cause: error.cause as Error | undefined }
      );

    case "MediaError":
      return new ChalkError(
        ChalkErrorCode[error.code],
        error.message,
        { recoverable: error.recoverable, details: { ...error.details, deviceId: error.deviceId }, cause: error.cause as Error | undefined }
      );

    case "RoomError":
      return new ChalkError(
        ChalkErrorCode[error.code],
        error.message,
        { recoverable: error.recoverable, details: { ...error.details, roomId: error.roomId }, cause: error.cause as Error | undefined }
      );

    case "RecordingError":
      return new ChalkError(
        ChalkErrorCode[error.code],
        error.message,
        { recoverable: error.recoverable, details: { ...error.details, recordingId: error.recordingId }, cause: error.cause as Error | undefined }
      );

    case "GenericError":
      return new ChalkError(
        ChalkErrorCode[error.code],
        error.message,
        { recoverable: error.recoverable, details: error.details, cause: error.cause as Error | undefined }
      );

    case "TimeoutError":
      return new ChalkError(
        ChalkErrorCode.CONNECTION_FAILED,
        error.message,
        { recoverable: true, details: { operation: error.operation, timeoutMs: error.timeoutMs } }
      );

    case "ParseError":
      return new ChalkError(
        ChalkErrorCode.INVALID_PARAMS,
        error.message,
        { recoverable: false, details: { input: error.input, path: error.path } }
      );
  }
};

/**
 * Convert legacy ChalkError to SDK Error
 */
export const fromChalkError = (error: ChalkError): SDKError => {
  const base = {
    message: error.message,
    recoverable: error.recoverable,
    details: error.details,
    cause: error.cause,
  };

  switch (error.code) {
    case ChalkErrorCode.CONNECTION_FAILED:
    case ChalkErrorCode.CONNECTION_LOST:
    case ChalkErrorCode.RECONNECT_FAILED:
    case ChalkErrorCode.WEBSOCKET_ERROR:
      return new ConnectionError({ ...base, code: error.code });

    case ChalkErrorCode.AUTH_FAILED:
    case ChalkErrorCode.TOKEN_EXPIRED:
    case ChalkErrorCode.TOKEN_REFRESH_FAILED:
    case ChalkErrorCode.INVALID_API_KEY:
    case ChalkErrorCode.PERMISSION_DENIED:
      return new AuthError({ ...base, code: error.code, tokenExpired: error.code === ChalkErrorCode.TOKEN_EXPIRED });

    case ChalkErrorCode.MEDIA_PERMISSION_DENIED:
    case ChalkErrorCode.DEVICE_NOT_FOUND:
    case ChalkErrorCode.DEVICE_IN_USE:
    case ChalkErrorCode.SCREEN_SHARE_CANCELLED:
    case ChalkErrorCode.SCREEN_SHARE_FAILED:
    case ChalkErrorCode.OVERCONSTRAINED:
      return new MediaError({ ...base, code: error.code });

    case ChalkErrorCode.ROOM_NOT_FOUND:
    case ChalkErrorCode.ROOM_FULL:
    case ChalkErrorCode.ALREADY_IN_ROOM:
    case ChalkErrorCode.NOT_IN_ROOM:
    case ChalkErrorCode.ROOM_ENDED:
      return new RoomError({ ...base, code: error.code });

    case ChalkErrorCode.RECORDING_FAILED:
    case ChalkErrorCode.RECORDING_IN_PROGRESS:
    case ChalkErrorCode.NO_ACTIVE_RECORDING:
      return new RecordingError({ ...base, code: error.code });

    case ChalkErrorCode.UNKNOWN:
    case ChalkErrorCode.INVALID_PARAMS:
    case ChalkErrorCode.RATE_LIMITED:
    case ChalkErrorCode.SERVER_ERROR:
    default:
      return new GenericError({ ...base, code: error.code as "UNKNOWN" | "INVALID_PARAMS" | "RATE_LIMITED" | "SERVER_ERROR" });
  }
};
