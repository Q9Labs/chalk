/**
 * Error handling for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/errors
 */

/**
 * Error codes for Chalk SDK operations.
 *
 * Organized by category:
 * - CONNECTION_* - Network and WebSocket errors
 * - AUTH_* - Authentication errors
 * - MEDIA_* - Camera, microphone, screen share errors
 * - ROOM_* - Room lifecycle errors
 * - RECORDING_* - Recording errors
 */
export enum ChalkErrorCode {
  // Connection errors
  /** Initial connection to server failed */
  CONNECTION_FAILED = 'CONNECTION_FAILED',

  /** Connection was lost unexpectedly */
  CONNECTION_LOST = 'CONNECTION_LOST',

  /** Reconnection attempts exhausted */
  RECONNECT_FAILED = 'RECONNECT_FAILED',

  /** WebSocket error occurred */
  WEBSOCKET_ERROR = 'WEBSOCKET_ERROR',

  // Authentication errors
  /** Authentication failed (invalid credentials) */
  AUTH_FAILED = 'AUTH_FAILED',

  /** JWT token has expired */
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',

  /** Token refresh failed */
  TOKEN_REFRESH_FAILED = 'TOKEN_REFRESH_FAILED',

  /** Invalid API key format or not found */
  INVALID_API_KEY = 'INVALID_API_KEY',

  /** Insufficient permissions for operation */
  PERMISSION_DENIED = 'PERMISSION_DENIED',

  // Media errors
  /** User denied camera/microphone permission */
  MEDIA_PERMISSION_DENIED = 'MEDIA_PERMISSION_DENIED',

  /** Requested device not found */
  DEVICE_NOT_FOUND = 'DEVICE_NOT_FOUND',

  /** Device is in use by another application */
  DEVICE_IN_USE = 'DEVICE_IN_USE',

  /** Screen share was cancelled by user */
  SCREEN_SHARE_CANCELLED = 'SCREEN_SHARE_CANCELLED',

  /** Screen share failed to start */
  SCREEN_SHARE_FAILED = 'SCREEN_SHARE_FAILED',

  /** Media constraints not satisfiable */
  OVERCONSTRAINED = 'OVERCONSTRAINED',

  // Room errors
  /** Room does not exist */
  ROOM_NOT_FOUND = 'ROOM_NOT_FOUND',

  /** Room has reached maximum participants */
  ROOM_FULL = 'ROOM_FULL',

  /** Already connected to a room */
  ALREADY_IN_ROOM = 'ALREADY_IN_ROOM',

  /** Not currently in a room */
  NOT_IN_ROOM = 'NOT_IN_ROOM',

  /** Room has ended */
  ROOM_ENDED = 'ROOM_ENDED',

  // Recording errors
  /** Recording failed to start */
  RECORDING_FAILED = 'RECORDING_FAILED',

  /** Recording already in progress */
  RECORDING_IN_PROGRESS = 'RECORDING_IN_PROGRESS',

  /** No active recording to stop */
  NO_ACTIVE_RECORDING = 'NO_ACTIVE_RECORDING',

  // Generic errors
  /** Unknown error occurred */
  UNKNOWN = 'UNKNOWN',

  /** Invalid parameters provided */
  INVALID_PARAMS = 'INVALID_PARAMS',

  /** Request rate limited */
  RATE_LIMITED = 'RATE_LIMITED',

  /** Server error */
  SERVER_ERROR = 'SERVER_ERROR',
}

/**
 * Custom error class for Chalk SDK operations.
 *
 * Includes structured error codes for programmatic handling and
 * a `recoverable` flag indicating whether the operation can be retried.
 *
 * @example
 * ```ts
 * try {
 *   await session.media.toggleVideo();
 * } catch (error) {
 *   if (error instanceof ChalkError) {
 *     if (error.code === ChalkErrorCode.MEDIA_PERMISSION_DENIED) {
 *       showPermissionRequestDialog();
 *     } else if (error.recoverable) {
 *       // Can retry
 *       await retry(() => session.media.toggleVideo());
 *     }
 *   }
 * }
 * ```
 */
export class ChalkError extends Error {
  /** Structured error code for programmatic handling */
  readonly code: ChalkErrorCode;

  /** Whether this error is recoverable (can retry) */
  readonly recoverable: boolean;

  /** Additional error context */
  readonly details?: Record<string, unknown>;

  constructor(
    code: ChalkErrorCode,
    message: string,
    options?: {
      recoverable?: boolean;
      details?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(message, { cause: options?.cause });
    this.name = 'ChalkError';
    this.code = code;
    this.recoverable = options?.recoverable ?? false;
    this.details = options?.details;

    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ChalkError);
    }
  }

  /**
   * Create error from a DOMException (browser media errors)
   */
  static fromDOMException(err: DOMException): ChalkError {
    switch (err.name) {
      case 'NotAllowedError':
        return new ChalkError(
          ChalkErrorCode.MEDIA_PERMISSION_DENIED,
          'Permission denied for media device',
          { cause: err, recoverable: true }
        );
      case 'NotFoundError':
        return new ChalkError(
          ChalkErrorCode.DEVICE_NOT_FOUND,
          'Media device not found',
          { cause: err }
        );
      case 'NotReadableError':
        return new ChalkError(
          ChalkErrorCode.DEVICE_IN_USE,
          'Media device is in use by another application',
          { cause: err, recoverable: true }
        );
      case 'OverconstrainedError':
        return new ChalkError(
          ChalkErrorCode.OVERCONSTRAINED,
          'Media constraints cannot be satisfied',
          { cause: err, details: { constraint: (err as OverconstrainedError).constraint } }
        );
      case 'AbortError':
        return new ChalkError(
          ChalkErrorCode.SCREEN_SHARE_CANCELLED,
          'Screen share was cancelled',
          { cause: err }
        );
      default:
        return new ChalkError(
          ChalkErrorCode.UNKNOWN,
          err.message,
          { cause: err }
        );
    }
  }

  /**
   * Create error from HTTP response
   */
  static fromHttpError(status: number, message?: string): ChalkError {
    switch (status) {
      case 401:
        return new ChalkError(
          ChalkErrorCode.AUTH_FAILED,
          message ?? 'Authentication failed',
          { recoverable: true }
        );
      case 403:
        return new ChalkError(
          ChalkErrorCode.PERMISSION_DENIED,
          message ?? 'Permission denied'
        );
      case 404:
        return new ChalkError(
          ChalkErrorCode.ROOM_NOT_FOUND,
          message ?? 'Resource not found'
        );
      case 409:
        return new ChalkError(
          ChalkErrorCode.ALREADY_IN_ROOM,
          message ?? 'Conflict'
        );
      case 429:
        return new ChalkError(
          ChalkErrorCode.RATE_LIMITED,
          message ?? 'Rate limited',
          { recoverable: true }
        );
      case 500:
      case 502:
      case 503:
        return new ChalkError(
          ChalkErrorCode.SERVER_ERROR,
          message ?? 'Server error',
          { recoverable: true }
        );
      default:
        return new ChalkError(
          ChalkErrorCode.UNKNOWN,
          message ?? `HTTP error ${status}`
        );
    }
  }

  /**
   * Wrap any error as a ChalkError
   */
  static wrap(err: unknown): ChalkError {
    if (err instanceof ChalkError) {
      return err;
    }
    if (err instanceof DOMException) {
      return ChalkError.fromDOMException(err);
    }
    if (err instanceof Error) {
      return new ChalkError(ChalkErrorCode.UNKNOWN, err.message, { cause: err });
    }
    return new ChalkError(ChalkErrorCode.UNKNOWN, String(err));
  }
}
