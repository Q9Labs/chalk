/**
 * Core types for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core
 */

// ============================================================================
// Result Types - For type-safe error handling
// ============================================================================

/**
 * Represents a successful result
 * @typeParam T - The success value type
 */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/**
 * Represents a failed result
 * @typeParam E - The error type
 */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/**
 * A Result type for operations that can fail
 * Use pattern matching with `if (result.ok)` for type-safe access
 *
 * @example
 * ```ts
 * const result = await client.joinSession(roomId, config);
 * if (result.ok) {
 *   console.log('Joined room:', result.value.id);
 * } else {
 *   console.error('Failed:', result.error.message);
 * }
 * ```
 */
export type Result<T, E = ChalkError> = Ok<T> | Err<E>;

/** Create a successful result */
export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

/** Create a failed result */
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

// ============================================================================
// Client Configuration
// ============================================================================

/**
 * Function that provides a fresh JWT token
 * Called before each API request when using tokenProvider
 *
 * @example
 * ```ts
 * const tokenProvider = async () => {
 *   const response = await fetch('/api/chalk-token');
 *   const { token } = await response.json();
 *   return token;
 * };
 * ```
 */
export type TokenProvider = () => Promise<string>;

export type RealtimeKitLoader = import("./realtimekit/runtime").RealtimeKitLoader;

/**
 * Configuration options for ConferenceClient
 *
 * Authentication is required - provide either:
 * - `token`: Static JWT token (simplest option)
 * - `tokenProvider`: Function that returns a fresh JWT (recommended for browser)
 * - `apiKey`: DEPRECATED - Will be removed in v2.0
 *
 * @example
 * ```ts
 * // Option 1: Static token (simplest)
 * const client = new ConferenceClient({ token: 'jwt_xxx' });
 *
 * // Option 2: Dynamic token provider (recommended for browser apps)
 * const client = new ConferenceClient({
 *   tokenProvider: async () => {
 *     const res = await fetch('/api/chalk-token');
 *     const { token } = await res.json();
 *     return token;
 *   }
 * });
 *
 * // Option 3: API key (DEPRECATED - security risk in browser)
 * const client = new ConferenceClient({ apiKey: 'ck_live_xxx' });
 * ```
 */
export interface ConferenceClientConfig {
  /**
   * Static JWT token for authentication
   * Use this when you have a pre-fetched token from your server
   * @example 'eyJhbGciOiJIUzI1NiIs...'
   */
  token?: string;

  /**
   * Dynamic token provider function (recommended for browser apps)
   * Called before each API request to get a fresh token
   * Enables automatic token refresh on 401 errors
   */
  tokenProvider?: TokenProvider;

  /**
   * @deprecated Use `token` or `tokenProvider` instead.
   * API keys should not be exposed in client-side applications.
   * This option will be removed in v2.0.
   *
   * API key for authentication (server-side only)
   * @example 'ck_live_xxxxx'
   */
  apiKey?: string;

  /**
   * API base URL
   * @default 'https://chalk-api.q9labs.ai'
   */
  apiUrl?: string;

  /**
   * WebSocket URL for real-time events
   * @default 'wss://api.chalk.dev/ws'
   */
  wsUrl?: string;

  /**
   * Optional RealtimeKit module loader.
   * Defaults to the web RealtimeKit package.
   *
   * Use this to provide a platform-specific loader, such as React Native.
   */
  realtimeKitLoader?: import("./realtimekit/runtime").RealtimeKitLoader;

  /**
   * Enable debug logging to console
   * @default false
   */
  debug?: boolean;

  /**
   * Use demo API endpoints (demoJoin instead of addParticipant)
   * @default false
   */
  demoMode?: boolean;

  /**
   * Wide events configuration for comprehensive logging
   * Wide events emit one context-rich event per operation with full timing
   *
   * @example
   * ```ts
   * const client = new ConferenceClient({
   *   apiUrl: "https://api.chalk.io",
   *   token: "...",
   *   wideEvents: {
   *     enabled: true,
   *     handler: (event) => analytics.track("chalk_sdk", event),
   *   },
   * });
   * ```
   */
  wideEvents?: {
    /** Enable wide events (default: true when debug: true) */
    enabled?: boolean;
    /** Custom handler for sending events to analytics/logging services */
    handler?: (event: import("./wide-events/types").WideEvent) => void;
    /** Include debug info like stack traces (default: false) */
    includeDebugInfo?: boolean;
  };

  /**
   * Axiom wide-events ingestion helper.
   *
   * WARNING: Using a token in the browser exposes it to end users. Prefer proxy ingestion.
   */
  axiom?: {
    enabled?: boolean;
    token: string;
    dataset: string;
    endpoint?: string;
    flushIntervalMs?: number;
    maxBatchSize?: number;
    debug?: boolean;
  };

  /**
   * Incident reporting configuration.
   *
   * Use this to capture and ship SDK incidents (all surfaced SDK errors),
   * including support code + trace correlation, without app-specific wiring.
   */
  incident?: import("./incident").ChalkIncidentConfig;
}

// ============================================================================
// ConferenceSession Types
// ============================================================================

/**
 * Connection status of a room
 * - `connecting`: Initial connection in progress
 * - `connected`: Successfully connected
 * - `reconnecting`: Temporarily disconnected, attempting to reconnect
 * - `disconnected`: Cleanly disconnected
 * - `failed`: Connection failed permanently
 */
export type SessionConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected" | "failed";

/**
 * Configuration for joining a room
 *
 * @example
 * ```ts
 * await client.joinSession('room_123', {
 *   displayName: 'John Doe',
 *   audio: true,
 *   video: true,
 *   metadata: { role: 'teacher' }
 * });
 * ```
 */
export interface JoinSessionConfig {
  /**
   * Display name shown to other participants
   * @example 'John Doe'
   */
  displayName: string;

  /**
   * Participant role - determines permissions like recording control
   * @default 'participant'
   */
  role?: "host" | "participant";

  /**
   * Enable microphone on join
   * @default false
   */
  audio?: boolean;

  /**
   * Enable camera on join
   * @default false
   */
  video?: boolean;

  /**
   * Custom metadata attached to your participant
   * Visible to all participants in the room
   */
  metadata?: Record<string, unknown>;
}

/**
 * Information about a room
 */
export interface SessionInfo {
  /** Unique room identifier */
  id: string;
  /** Human-readable room name */
  name?: string;
  /** Current connection status */
  status: SessionConnectionState;
  /** Number of participants currently in the room */
  participantCount: number;
  /** ConferenceSession configuration */
  config: Record<string, unknown>;
  /** When the room was created */
  createdAt: Date;
}

/**
 * Lifecycle status for persisted rooms managed by the REST API
 */
export type RoomLifecycleStatus = "scheduled" | "active" | "ended";

/**
 * Configuration payload for room creation/scheduling
 */
export interface CreateRoomConfig {
  maxParticipants?: number;
  recordingEnabled?: boolean;
  chatEnabled?: boolean;
  [key: string]: unknown;
}

/**
 * SDK options for creating a room without joining it
 */
export interface CreateRoomOptions {
  name?: string;
  config?: CreateRoomConfig;
}

/**
 * SDK options for scheduling a room
 */
export interface ScheduleRoomOptions extends CreateRoomOptions {
  scheduledStartAt: string | Date;
  scheduledEndAt?: string | Date;
  allowEarlyJoinMinutes?: number;
}

/**
 * Room resource returned from room create/schedule APIs
 */
export interface RoomResource {
  id: string;
  tenantId: string;
  cloudflareMeetingId: string;
  name?: string | null;
  config: Record<string, unknown>;
  status: RoomLifecycleStatus;
  activeParticipantCount?: number;
  scheduledStartAt?: string | null;
  scheduledEndAt?: string | null;
  allowEarlyJoinMinutes: number;
  startedAt?: string | null;
  endedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListRoomsOptions {
  limit?: number;
  offset?: number;
  status?: RoomLifecycleStatus[];
}

export interface ListRoomsResponse {
  rooms: RoomResource[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateJoinTokenResponse {
  joinToken: string;
}

export interface ExchangeJoinTokenResponse {
  accessToken: string;
  expiresIn: number;
  roomId: string;
  roomName: string;
}

// ============================================================================
// Participant Types
// ============================================================================

/**
 * Role of a participant in the room
 * - `host`: Can manage the room, mute others, start recordings
 * - `participant`: Standard participant with media controls
 */
export type ParticipantRole = "host" | "participant";

/**
 * Represents a participant in a room
 *
 * @example
 * ```ts
 * room.on('participant.joined', (participant) => {
 *   console.log(`${participant.displayName} joined`);
 *   if (participant.videoTrack) {
 *     attachVideoToElement(participant.videoTrack, videoElement);
 *   }
 * });
 * ```
 */
export interface Participant {
  /** Unique participant identifier (RTK session ID) */
  id: string;
  /** User ID from authentication system (use this for chat message matching) */
  userId?: string;
  /** Display name visible to others */
  displayName: string;
  /** Role in the room */
  role: ParticipantRole;
  /** Whether this is the local (your) participant */
  isLocal: boolean;
  /**
   * Video MediaStreamTrack if publishing
   * Use with HTMLVideoElement.srcObject = new MediaStream([track])
   */
  videoTrack?: MediaStreamTrack;
  /**
   * Audio MediaStreamTrack if publishing
   * Usually handled automatically, but available for custom audio processing
   */
  audioTrack?: MediaStreamTrack;
  /**
   * Screen share video MediaStreamTrack if sharing screen
   * Use with HTMLVideoElement.srcObject = new MediaStream([track])
   */
  screenShareTrack?: MediaStreamTrack;
  /**
   * Screen share audio MediaStreamTrack if sharing screen with audio
   * Available when screen sharing includes system audio (browser support varies)
   */
  screenShareAudioTrack?: MediaStreamTrack;
  /** Camera is enabled and publishing */
  videoEnabled: boolean;
  /** Microphone is enabled (not muted) */
  audioEnabled: boolean;
  /** Currently speaking (voice activity detected) */
  isSpeaking: boolean;
  /** Currently sharing screen */
  isScreenSharing: boolean;
  /** Has raised hand to speak */
  handRaised: boolean;
  /**
   * Connection quality score
   * @min 0
   * @max 100
   */
  connectionQuality: number;
  /** When this participant joined the room */
  joinedAt?: Date;
  /** Custom metadata set when joining */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Media Types
// ============================================================================

/** Type of media track */
export type TrackKind = "audio" | "video";

/**
 * Represents a media track (audio or video)
 */
export interface Track {
  /** Unique track identifier */
  id: string;
  /** Type of track */
  kind: TrackKind;
  /** Whether the track is currently enabled */
  enabled: boolean;
  /** Underlying browser MediaStreamTrack */
  mediaStreamTrack?: MediaStreamTrack;
}

/** Type of media device */
export type MediaDeviceKind = "audioinput" | "audiooutput" | "videoinput";

/**
 * Information about an available media device
 *
 * @example
 * ```ts
 * const devices = await room.getDevices();
 * const cameras = devices.filter(d => d.kind === 'videoinput');
 * await room.selectDevice(cameras[0].deviceId, 'video');
 * ```
 */
export interface MediaDevice {
  /** Unique device identifier for selection */
  deviceId: string;
  /** Human-readable device name */
  label: string;
  /** Type of device */
  kind: MediaDeviceKind;
  /** Whether this is the currently selected device */
  isActive?: boolean;
}

/**
 * Constraints for media capture
 * Can be a simple boolean or detailed MediaTrackConstraints
 */
export interface MediaConstraints {
  /** Video constraints */
  video?: boolean | MediaTrackConstraints;
  /** Audio constraints */
  audio?: boolean | MediaTrackConstraints;
}

// ============================================================================
// Chat Types
// ============================================================================

/**
 * A chat message in the room
 */
export interface ChatAttachment {
  /** Unique attachment identifier */
  id: string;
  /** Original file name */
  fileName: string;
  /** Attachment MIME type */
  mimeType: string;
  /** Attachment size in bytes */
  sizeBytes: number;
  /** Classified attachment kind */
  kind: "image" | "document" | "file";
}

export interface ChatReadReceipt {
  /** Participant ID of the reader */
  participantId: string;
  /** Display name of the reader */
  displayName: string;
  /** When the message was read */
  readAt: Date;
}

export interface ChatMessage {
  /** Unique message identifier */
  id: string;
  /** Participant ID of the sender */
  senderId: string;
  /** Display name of the sender */
  senderName: string;
  /** Message content */
  content: string;
  /** When the message was sent */
  timestamp: Date;
  /** Attached files for this message */
  attachments?: ChatAttachment[];
  /** Sender-visible read receipts */
  readBy?: ChatReadReceipt[];
}

// ============================================================================
// Recording Types
// ============================================================================

/**
 * Status of a recording
 * - `pending`: Recording requested but not started
 * - `recording`: Currently recording
 * - `processing`: Recording stopped, being processed
 * - `ready`: Recording available for download
 * - `archived`: Recording moved to long-term storage
 * - `failed`: Recording failed
 * - `deleted`: Recording has been deleted
 */
export type RecordingStatus = "pending" | "recording" | "processing" | "ready" | "archived" | "failed" | "deleted";

/**
 * A room recording
 */
export interface Recording {
  /** Unique recording identifier */
  id: string;
  /** ConferenceSession that was recorded */
  roomId: string;
  /** Current status */
  status: RecordingStatus;
  /** Duration in seconds (available after processing) */
  durationSeconds?: number;
  /** File size in bytes (available after processing) */
  sizeBytes?: number;
  /** Pre-signed download URL (available when ready) */
  downloadUrl?: string;
  /** When recording started */
  startedAt?: Date;
  /** When recording stopped */
  endedAt?: Date;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error codes for Chalk SDK operations
 */
export const ChalkErrorCode = {
  // Network errors
  NETWORK_ERROR: "NETWORK_ERROR",
  CONNECTION_FAILED: "CONNECTION_FAILED",
  CONNECTION_LOST: "CONNECTION_LOST",
  MAX_RECONNECT_ATTEMPTS: "MAX_RECONNECT_ATTEMPTS",
  WS_ERROR: "WS_ERROR",

  // Auth errors
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  INVALID_API_KEY: "INVALID_API_KEY",

  // ConferenceSession errors
  ROOM_NOT_FOUND: "ROOM_NOT_FOUND",
  ROOM_FULL: "ROOM_FULL",
  ROOM_ENDED: "ROOM_ENDED",
  NOT_IN_ROOM: "NOT_IN_ROOM",

  // Media errors
  MEDIA_ERROR: "MEDIA_ERROR",
  CAMERA_ACCESS_DENIED: "CAMERA_ACCESS_DENIED",
  MICROPHONE_ACCESS_DENIED: "MICROPHONE_ACCESS_DENIED",
  DEVICE_NOT_FOUND: "DEVICE_NOT_FOUND",
  SCREEN_SHARE_ERROR: "SCREEN_SHARE_ERROR",
  SCREEN_SHARE_CANCELLED: "SCREEN_SHARE_CANCELLED",
  OVERCONSTRAINED: "OVERCONSTRAINED",
  SCREEN_SHARE_FAILED: "SCREEN_SHARE_FAILED",

  // Recording errors
  RECORDING_FAILED: "RECORDING_FAILED",
  RECORDING_NOT_FOUND: "RECORDING_NOT_FOUND",

  // General errors
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
  INVALID_REQUEST: "INVALID_REQUEST",
  RATE_LIMITED: "RATE_LIMITED",
} as const;

export type ChalkErrorCode = (typeof ChalkErrorCode)[keyof typeof ChalkErrorCode];

/**
 * Error object returned by Chalk SDK operations
 *
 * @example
 * ```ts
 * room.on('error', (error) => {
 *   if (error.code === ChalkErrorCode.CAMERA_ACCESS_DENIED) {
 *     showPermissionDialog();
 *   }
 * });
 * ```
 */
export interface ChalkError {
  /** Error code for programmatic handling */
  code: ChalkErrorCode | string;
  /** Human-readable error message */
  message: string;
  /** Additional error details */
  details?: Record<string, unknown>;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * All event types emitted by Chalk SDK
 */
export type ChalkEventType =
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "error"
  | "participant.joined"
  | "participant.left"
  | "participant.updated"
  | "track.subscribed"
  | "track.unsubscribed"
  | "speaker.active.changed"
  | "chat.message"
  | "chat.read"
  | "reaction"
  | "hand.raised"
  | "hand.lowered"
  | "recording.started"
  | "recording.stopped"
  | "room.updated";

// ============================================================================
// Screen Share Types
// ============================================================================

/**
 * Options for screen sharing
 */
export interface ScreenShareOptions {
  /**
   * Include system audio in the share (browser support varies)
   * @default false
   */
  withAudio?: boolean;
}

// ============================================================================
// Reaction Types
// ============================================================================

/** Available reaction emojis */
export type ReactionEmoji = "👍" | "👎" | "❤️" | "🎉" | "😂" | "😮" | "😢" | "🤔";

/**
 * A reaction sent by a participant
 */
export interface Reaction {
  /** Who sent the reaction */
  participantId: string;
  /** Display name of sender */
  participantName: string;
  /** The emoji */
  emoji: ReactionEmoji;
  /** When it was sent */
  timestamp: Date;
}

// ============================================================================
// Token Types
// ============================================================================

/**
 * Set of tokens returned when joining a room
 *
 * The SDK uses three different tokens for different purposes:
 * - `accessToken`: JWT for authenticating with Chalk REST API
 * - `refreshToken`: Used to obtain new tokens when accessToken expires
 * - `rtcToken`: Cloudflare RealtimeKit token for WebRTC connections
 *
 * @example
 * ```ts
 * const result = await client.joinSession('room_123', { displayName: 'John' });
 * // result.tokens.accessToken - Use for API calls
 * // result.tokens.rtcToken - Used internally for WebRTC
 * ```
 */
export interface TokenSet {
  /**
   * Chalk API JWT for REST API authentication
   * Used for all HTTP requests to Chalk backend
   */
  accessToken: string;

  /**
   * Refresh token for obtaining new access tokens
   * Optional - only provided when refresh flow is enabled
   * WARNING: Do not store in browser localStorage for security
   */
  refreshToken?: string;

  /**
   * Cloudflare RealtimeKit token for WebRTC connections
   * Used internally by the SDK to establish WebRTC sessions
   */
  rtcToken: string;

  /**
   * Unix timestamp (milliseconds) when tokens expire
   * Use this to proactively refresh tokens before expiry
   */
  expiresAt?: number;
}

/**
 * Result returned when successfully joining a room
 *
 * Contains room information, participant details, and authentication tokens
 */
export interface JoinSessionResult {
  /** Information about the joined room */
  room: SessionInfo;

  /** The local participant (you) in the room */
  participant: Participant;

  /** Authentication tokens for API and WebRTC */
  tokens: TokenSet;
}

// ============================================================================
// API Response Types
// ============================================================================

/**
 * Standard API response wrapper
 * @internal
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ChalkError;
}

/**
 * Response from creating a room
 * @internal
 */
export interface CreateRoomResponse {
  /**
   * Legacy room ID field kept for backward compatibility.
   * Prefer `id` for new integrations.
   */
  roomId: string;
  id?: string;
  name?: string | null;
  tenantId?: string;
  cloudflareMeetingId?: string;
  config?: Record<string, unknown>;
  status?: RoomLifecycleStatus;
  scheduledStartAt?: string | null;
  scheduledEndAt?: string | null;
  allowEarlyJoinMinutes?: number;
  startedAt?: string | null;
  endedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Tenant configuration returned from the API */
export interface TenantConfig {
  transcriptionEnabled: boolean;
  firstParticipantIsHost: boolean;
  forceRecording: boolean;
  allowEarlyJoin: boolean;
}

/**
 * Response from joining a room (internal API response format)
 * @internal
 */
export interface JoinSessionResponse {
  participantId: string;
  /**
   * Role assigned to the participant
   */
  role: "host" | "participant";
  /**
   * Authentication tokens for the session
   */
  tokens: TokenSet;
  room: SessionInfo;
  /**
   * Whether the room was just created (not pre-existing)
   */
  roomCreated?: boolean;
  /**
   * Tenant configuration for this room
   */
  tenantConfig?: TenantConfig;
  /**
   * Whether the SDK should auto-start recording (tenant has force_recording enabled)
   */
  shouldStartRecording?: boolean;
}

/**
 * Raw API response from join room endpoint (snake_case from Go API)
 * @internal
 */
export interface RawJoinSessionApiResponse {
  success: boolean;
  room_id: string;
  participant_id: string;
  access_token?: string;
  refresh_token?: string;
  auth_token: string;
  token?: string;
  expires_at?: number;
  room: {
    id: string;
    name: string;
  };
}

/**
 * Transformed API response from join room endpoint (camelCase after transform)
 * @internal
 */
export interface TransformedJoinSessionApiResponse {
  success: boolean;
  roomId: string;
  participantId: string;
  role?: "host" | "participant";
  accessToken?: string;
  refreshToken?: string;
  authToken: string;
  token?: string;
  expiresAt?: number;
  roomCreated?: boolean;
  tenantConfig?: TenantConfig;
  shouldStartRecording?: boolean;
  room: {
    id: string;
    name: string;
  };
}

// ============================================================================
// Deprecated / Legacy Types (for backwards compatibility)
// ============================================================================

/**
 * @deprecated Use MediaDevice instead
 */
export type MediaDeviceInfo = MediaDevice;

// ============================================================================
// Snapshot Types - For reconnect/sync state
// ============================================================================

/**
 * ConferenceSession snapshot received on connect/reconnect
 * Contains full room state for synchronization
 */
export interface SessionSnapshot {
  /** ConferenceSession identifier */
  roomId: string;
  /** All participants currently in the room */
  participants: Participant[];
  /** Whether the room is currently being recorded */
  isRecording: boolean;
  /** Current recording ID if recording */
  recordingId?: string;
  /** Last sequence number for event ordering */
  lastSeq: number;
  /** Durable chat history for the room */
  messages?: ChatMessage[];
}

/**
 * Payload for participant update events with detailed changes
 */
export interface ParticipantUpdatedPayload {
  /** ID of the participant that was updated */
  participantId: string;
  /** Changes that occurred */
  changes: {
    /** Updated display name */
    displayName?: string;
    /** Whether video is enabled */
    videoEnabled?: boolean;
    /** Whether audio is enabled */
    audioEnabled?: boolean;
    /** Whether participant is currently speaking */
    isSpeaking?: boolean;
    /** Whether participant is sharing their screen */
    isScreenSharing?: boolean;
    /** Whether hand is raised */
    handRaised?: boolean;
    /** Connection quality score (0-100) */
    connectionQuality?: number;
  };
}
