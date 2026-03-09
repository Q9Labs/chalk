/**
 * ConferenceSession entity types for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/types
 */

/**
 * Connection status of a room
 */
export type SessionConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected" | "failed";

/**
 * Represents a video conferencing room
 *
 * @example
 * ```ts
 * room.on('room:updated', ({ room }) => {
 *   if (room.status === 'failed') {
 *     showErrorMessage('Connection lost');
 *   }
 * });
 * ```
 */
export interface ConferenceSession {
  /** Unique room identifier (UUID) */
  readonly id: string;

  /** Human-readable room name */
  name?: string;

  /** Current connection status */
  status: SessionConnectionState;

  /** When the room was created */
  createdAt: Date;

  /** Participant ID of the room host */
  hostId?: string;

  /** Whether the room is currently being recorded */
  isRecording: boolean;

  /** Current recording ID if recording */
  recordingId?: string;

  /** ConferenceSession configuration */
  config?: JoinSessionConfig;
}

/**
 * ConferenceSession configuration options
 */
export interface JoinSessionConfig {
  /** Maximum number of participants allowed */
  maxParticipants?: number;

  /** Whether recording is enabled for this room */
  recordingEnabled?: boolean;

  /** Whether chat is enabled for this room */
  chatEnabled?: boolean;

  /** Additional custom configuration */
  [key: string]: unknown;
}

/**
 * Options for joining a room
 */
export interface JoinOptions {
  /** Display name for the participant */
  userName: string;

  /** Role for the participant (host gets recording controls, etc.) */
  role?: "host" | "participant";

  /** Enable audio on join */
  audioEnabled?: boolean;

  /** Enable video on join */
  videoEnabled?: boolean;

  /** Custom metadata to attach to participant */
  metadata?: Record<string, unknown>;
}

/**
 * Options for leaving a room
 */
export interface LeaveOptions {
  /** End the room for all participants (host only) */
  endForAll?: boolean | (() => boolean);
}
