/**
 * Server → Client WebSocket event types for Chalk SDK
 *
 * These events are sent from the Go backend to the client.
 * Maps directly to MessageType constants in messages.go.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/types
 */
import type { AppState } from "@q9labs/chalk-whiteboard/collab";

// Server payloads use their own participant shape (ServerParticipant)
// rather than the full Participant entity from entities/

// ============================================================================
// Payload Types (matching Go structs in messages.go)
// ============================================================================

/** Sent when WebSocket connection is established */
export interface ConnectedPayload {
  participantId: string;
  roomId: string;
  tenantId: string;
}

/** Participant info from server */
export interface ServerParticipant {
  id: string;
  roomId: string;
  displayName: string;
  isActive: boolean;
  joinedAt: string; // ISO timestamp from server
}

/** Sent when a participant joins */
export interface ParticipantJoinedPayload {
  participant: ServerParticipant;
}

/** Sent when a participant leaves */
export interface ParticipantLeftPayload {
  participantId: string;
  reason?: string;
}

/** Sent when a participant's state changes */
export interface ParticipantUpdatedPayload {
  participant: ServerParticipant;
  changes?: string[];
}

/** Chat message from server */
export interface ChatMessagePayload {
  id: string;
  participantId: string;
  displayName: string;
  content: string;
  timestamp: string; // ISO timestamp
}

/** Emoji reaction from server */
export interface ReactionPayload {
  participantId: string;
  emoji: string;
  timestamp: string;
}

/** Hand raised notification */
export interface HandRaisedPayload {
  participantId: string;
  timestamp: string;
}

/** Hand lowered notification */
export interface HandLoweredPayload {
  participantId: string;
  timestamp: string;
}

/** ConferenceSession state from server */
export interface ServerRoom {
  id: string;
  tenantId: string;
  name: string;
  isActive: boolean;
  startedAt: string;
  endedAt?: string;
}

/** ConferenceSession updated notification */
export interface RoomUpdatedPayload {
  room: ServerRoom;
}

/** Full room state sent on connection */
export interface RoomSnapshotPayload {
  roomId: string;
  participants: ServerParticipant[];
  isRecording: boolean;
  recordingId?: string;
  lastSeq: number;
}

/** Recording started notification */
export interface RecordingStartedPayload {
  recordingId: string;
  timestamp: string;
}

/** Recording stopped notification */
export interface RecordingStoppedPayload {
  recordingId: string;
  timestamp: string;
}

/** Error from server */
export interface ErrorPayload {
  code: string;
  message: string;
}

/** Ping from server */
export interface PingPayload {
  timestamp: string;
}

// Whiteboard payloads

/** Whiteboard data broadcast */
export interface WhiteboardDataPayload {
  /** Wire schema version (v2 = 2) */
  schemaVersion: 2;
  /** Scene epoch; changes on clear */
  sceneId: string;
  /** Whether this update represents a full-scene sync */
  syncAll: boolean;
  participantId: string;
  displayName: string;
  elements: unknown[];
  files?: Record<string, unknown>;
  seq: number;
  timestamp: string;
}

/** Whiteboard full state */
export interface WhiteboardSnapshotPayload {
  /** Wire schema version (v2 = 2) */
  schemaVersion: 2;
  roomId: string;
  /** Scene epoch; changes on clear */
  sceneId: string;
  elements: unknown[];
  files: Record<string, unknown>;
  appState: AppState;
  /** Snapshot updated timestamp (ms) */
  updatedAtMs?: number;
  lastSeq: number;
}

/** Whiteboard cursor position */
export interface WhiteboardCursorPayload {
  participantId: string;
  displayName: string;
  x: number;
  y: number;
  timestamp: string;
}

/** Whiteboard opened by participant */
export interface WhiteboardOpenedPayload {
  participantId: string;
  displayName: string;
  timestamp: string;
}

/** Whiteboard closed by participant */
export interface WhiteboardClosedPayload {
  participantId: string;
  timestamp: string;
}

/** Permission changed notification */
export interface PermissionChangedPayload {
  participantId: string;
  feature: "whiteboard";
  canDraw: boolean;
  grantedBy: string;
  timestamp: string;
}

// ============================================================================
// Server Event Map
// ============================================================================

/**
 * Map of all server → client WebSocket events.
 *
 * Event names use past tense to indicate they describe something that happened.
 * Format: `domain:action` (e.g., `participant:joined`, `chat:message`)
 *
 * @example
 * ```ts
 * // Type-safe event handling
 * session.on('participant:joined', (payload) => {
 *   // payload is typed as ParticipantJoinedPayload
 *   console.log(payload.participant.displayName);
 * });
 * ```
 */
export interface ServerEventMap {
  // Connection events
  connected: ConnectedPayload;

  // Participant events
  "participant:joined": ParticipantJoinedPayload;
  "participant:left": ParticipantLeftPayload;
  "participant:updated": ParticipantUpdatedPayload;

  // Chat events
  "chat:message": ChatMessagePayload;

  // Interaction events
  reaction: ReactionPayload;
  "hand:raised": HandRaisedPayload;
  "hand:lowered": HandLoweredPayload;

  // ConferenceSession events
  "room:updated": RoomUpdatedPayload;
  "room:snapshot": RoomSnapshotPayload;
  "room:ended": { reason: string };

  // Recording events
  "recording:started": RecordingStartedPayload;
  "recording:stopped": RecordingStoppedPayload;

  // Whiteboard events
  "whiteboard:data": WhiteboardDataPayload;
  "whiteboard:snapshot": WhiteboardSnapshotPayload;
  "whiteboard:cursor": WhiteboardCursorPayload;
  "whiteboard:opened": WhiteboardOpenedPayload;
  "whiteboard:closed": WhiteboardClosedPayload;

  // Permission events
  "permission:changed": PermissionChangedPayload;

  // Error events
  error: ErrorPayload;

  // Heartbeat
  ping: PingPayload;
}

/**
 * All server event names as a union type
 */
export type ServerEventName = keyof ServerEventMap;
