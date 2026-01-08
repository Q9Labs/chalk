/**
 * @q9labs/chalk-core - Core SDK for Chalk video conferencing
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core
 *
 * @example
 * ```ts
 * import { ChalkClient } from '@q9labs/chalk-core';
 *
 * const client = new ChalkClient({ token: 'jwt_xxx' });
 * const room = await client.joinRoom('room_123', {
 *   displayName: 'John Doe',
 *   audio: true,
 *   video: true,
 * });
 *
 * room.on('participant-joined', (p) => console.log(`${p.displayName} joined`));
 * ```
 */

// Main client
export { ChalkClient } from "./client.ts";
// Event emitter (for advanced use cases)
export { EventEmitter } from "./events.ts";
// Room
export { Room } from "./room.ts";
export {
	camelToSnake,
	camelToSnakeString,
	snakeToCamel,
	snakeToCamelString,
} from "./transforms.ts";

// ============================================================================
// New Phase 1 Exports (typed events, errors, utilities)
// ============================================================================

// Typed event emitter utility
export { TypedEventEmitter } from "./utils/typed-emitter.ts";

// Error handling
export { ChalkError as ChalkErrorClass, ChalkErrorCode as ErrorCode } from "./errors/chalk-error.ts";

// Namespaced type exports
export * as types from "./types/index.ts";

// Direct type exports for convenience
export type {
	// Event maps
	ServerEventMap,
	ClientEventMap,
	ServerEventName,
	ClientEventName,
	// Server event payloads
	ConnectedPayload,
	ParticipantJoinedPayload,
	ParticipantLeftPayload,
	ParticipantUpdatedPayload,
	ChatMessagePayload,
	ReactionPayload,
	HandRaisedPayload,
	HandLoweredPayload,
	RoomSnapshotPayload,
	RecordingStartedPayload,
	RecordingStoppedPayload,
	WhiteboardDataPayload,
	WhiteboardSnapshotPayload,
	WhiteboardCursorPayload,
	PermissionChangedPayload,
	// Client event payloads
	ChatSendPayload,
	ReactionSendPayload,
	WhiteboardUpdatePayload,
} from "./types/events/index.ts";

// Wire protocol helpers
export {
	serverMessageTypeMap,
	clientMessageTypeMap,
} from "./types/events/client-events.ts";

// ============================================================================
// Phase 2: Managers and Session (new SDK architecture)
// ============================================================================

// State container base class
export { StateContainer } from "./state/state-container.ts";

// ChalkSession - main orchestrator
export { ChalkSession } from "./session/chalk-session.ts";
export type { ChalkSessionConfig, ChalkSessionEvents } from "./session/chalk-session.ts";

// Individual managers
export {
  RoomManager,
  ParticipantManager,
  MediaManager,
  ScreenShareManager,
  ChatManager,
  RecordingManager,
  InteractionManager,
  UIManager,
  WhiteboardManager,
} from "./managers/index.ts";

// Manager state types
export type {
  RoomState,
  RoomManagerEvents,
  JoinOptions,
  LeaveOptions,
  ParticipantState,
  ParticipantManagerEvents,
  MediaState,
  MediaManagerEvents,
  ScreenShareState,
  ScreenShareManagerEvents,
  ChatState,
  ChatManagerEvents,
  RecordingState,
  RecordingManagerEvents,
  InteractionState,
  InteractionManagerEvents,
  ActiveReaction,
  UIState,
  UIManagerEvents,
  LayoutMode,
  PanelType,
  Notification,
  NotificationSeverity,
  WhiteboardState,
  WhiteboardManagerEvents,
} from "./managers/index.ts";

// Whiteboard types
export type { WhiteboardCursor } from "./types/entities/whiteboard.ts";

// Namespace exports for managers
export * as managers from "./managers/index.ts";
export * as session from "./session/index.ts";
export * as state from "./state/index.ts";

// ============================================================================
// Legacy exports (backward compatibility with existing code)
// ============================================================================

// Types from original types.ts
export type {
	ApiResponse,
	ChalkClientConfig,
	ChalkError,
	ChalkEventType,
	ChatMessage,
	CreateRoomResponse,
	Err,
	JoinRoomResponse,
	JoinRoomResult,
	MediaConstraints,
	MediaDevice,
	MediaDeviceInfo,
	MediaDeviceKind,
	Ok,
	Participant,
	ParticipantRole,
	Reaction,
	ReactionEmoji,
	Recording,
	RecordingStatus,
	Result,
	RoomConfig,
	RoomInfo,
	RoomStatus,
	ScreenShareOptions,
	TokenProvider,
	TokenSet,
	Track,
	TrackKind,
} from "./types.ts";
// Export error code constants
export { ChalkErrorCode, err, ok } from "./types.ts";
