/**
 * Wide Events Types
 *
 * Canonical log lines for comprehensive event tracking.
 * Each operation emits one context-rich event at completion.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/wide-events
 */

/** Event outcome status */
export type WideEventOutcome = "success" | "error" | "timeout";

/** Platform the SDK is running on */
export type WideEventPlatform = "browser" | "node" | "react-native";

/** SDK environment information */
export interface WideEventSdk {
  /** SDK version from package.json */
  version: string;
  /** Runtime platform */
  platform: WideEventPlatform;
  /** User agent string (browser only) */
  userAgent?: string;
}

/** Error information for failed events */
export interface WideEventError {
  /** Error code for programmatic handling */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Original error stack trace (debug only) */
  stack?: string;
}

/**
 * Wide Event - canonical log line
 *
 * Each operation emits exactly one WideEvent at completion with:
 * - Full timing breakdown (phases)
 * - Environment context (SDK version, platform)
 * - Session context (roomId, participantId)
 * - Operation-specific payload
 */
export interface WideEvent {
  /** Unique event identifier (UUID) */
  eventId: string;
  /** Event type (e.g., "room.join", "api.request", "media.toggle") */
  eventType: string;
  /** ISO 8601 timestamp when event completed */
  timestamp: string;

  /** SDK environment information */
  sdk: WideEventSdk;

  /** Session identifier (stable across reconnects) */
  sessionId: string;
  /** ConferenceSession identifier (if in a room) */
  roomId?: string;
  /** Participant identifier (if joined) */
  participantId?: string;

  /** Total operation duration in milliseconds */
  durationMs: number;
  /** Phase breakdown: phase name -> duration in ms */
  phases?: Record<string, number>;

  /** Operation outcome */
  outcome: WideEventOutcome;
  /** Error details (if outcome is "error") */
  error?: WideEventError;

  /** Event-specific payload data */
  data: Record<string, unknown>;
}

/**
 * Wide Events Configuration
 */
export interface WideEventConfig {
  /** Enable wide events emission (default: true when debug: true) */
  enabled?: boolean;
  /** Custom event handler for sending events to analytics/logging services */
  handler?: (event: WideEvent) => void;
  /** Include debug information like stack traces (default: false) */
  includeDebugInfo?: boolean;
  /** Session ID to use (auto-generated if not provided) */
  sessionId?: string;
}

/** Event types emitted by the SDK */
export type WideEventType =
  | "room.join"
  | "room.leave"
  | "room.reconnect"
  | "api.request"
  | "media.toggle"
  | "screenshare.start"
  | "screenshare.stop"
  | "reaction.send"
  | "reaction.receive"
  | "hand.raise"
  | "hand.lower"
  | "websocket.connect"
  | "websocket.disconnect"
  | "websocket.reconnect"
  | "websocket.error"
  | "participant.mute.request"
  | "participant.unmute.request"
  | "participant.mute.receive"
  | "participant.unmute.receive"
  | "participant.join"
  | "participant.leave"
  | "chat.send"
  | "recording.start"
  | "recording.stop"
  | "whiteboard.update"
  | "session.init"
  | "session.dispose";
