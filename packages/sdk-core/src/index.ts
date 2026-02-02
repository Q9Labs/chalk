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

// API client (for React Native SDK which uses its own RTK integration)
export { APIClient } from "./api-client.ts";
// Main client
export { ChalkClient } from "./client.ts";
// Event emitter (for advanced use cases)
export { EventEmitter } from "./events.ts";
// Room
export { Room, type Transcript } from "./room.ts";
export {
	camelToSnake,
	camelToSnakeString,
	snakeToCamel,
	snakeToCamelString,
} from "./transforms.ts";
// WebSocket client (for advanced/React Native integrations)
export { WSClient } from "./ws-client.ts";

// ============================================================================
// New Phase 1 Exports (typed events, errors, utilities)
// ============================================================================

// Error handling
export {
	ChalkError as ChalkErrorClass,
	ChalkErrorCode as ErrorCode,
} from "./errors/chalk-error.ts";
// Wire protocol helpers
export {
	clientMessageTypeMap,
	serverMessageTypeMap,
} from "./types/events/client-events.ts";
// Direct type exports for convenience
export type {
	ChatMessagePayload,
	// Client event payloads
	ChatSendPayload,
	ClientEventMap,
	ClientEventName,
	// Server event payloads
	ConnectedPayload,
	HandLoweredPayload,
	HandRaisedPayload,
	ParticipantJoinedPayload,
	ParticipantLeftPayload,
	ParticipantUpdatedPayload,
	PermissionChangedPayload,
	ReactionPayload,
	ReactionSendPayload,
	RecordingStartedPayload,
	RecordingStoppedPayload,
	RoomSnapshotPayload,
	// Event maps
	ServerEventMap,
	ServerEventName,
	WhiteboardCursorPayload,
	WhiteboardDataPayload,
	WhiteboardSnapshotPayload,
	WhiteboardUpdatePayload,
} from "./types/events/index.ts";
// Namespaced type exports
export * as types from "./types/index.ts";
// Typed event emitter utility
export { TypedEventEmitter } from "./utils/typed-emitter.ts";
export type {
	WideEvent,
	WideEventConfig,
	WideEventError,
	WideEventOutcome,
	WideEventPlatform,
	WideEventSdk,
	WideEventType,
} from "./wide-events/index.ts";
// Wide Events - canonical log lines for comprehensive event tracking
export {
	configureWideEvents,
	WideEventCollector,
	WideEventContext,
	wideEvents,
	wideEventsCollector,
} from "./wide-events/index.ts";

// ============================================================================
// Phase 2: Managers and Session (new SDK architecture)
// ============================================================================

// Manager state types
export type {
	ActiveReaction,
	ChatManagerEvents,
	ChatState,
	InteractionManagerEvents,
	InteractionState,
	JoinOptions,
	LayoutMode,
	LeaveOptions,
	MediaManagerEvents,
	MediaState,
	Notification,
	NotificationSeverity,
	PanelType,
	ParticipantManagerEvents,
	ParticipantState,
	RecordingManagerEvents,
	RecordingState,
	RoomManagerEvents,
	RoomState,
	ScreenShareManagerEvents,
	ScreenShareState,
	UIManagerEvents,
	UIState,
	WhiteboardManagerEvents,
	WhiteboardState,
} from "./managers/index.ts";
// Namespace exports for managers
export * as managers from "./managers/index.ts";
// Individual managers (non-Effect)
export {
	ChatManager,
	InteractionManager,
	RecordingManager,
	ScreenShareManager,
	UIManager,
	WhiteboardManager,
} from "./managers/index.ts";
export type {
	ChalkSessionConfig,
	ChalkSessionEvents,
} from "./session/chalk-session.ts";
// ChalkSession - main orchestrator
export { ChalkSession } from "./session/chalk-session.ts";
export * as session from "./session/index.ts";
export * as state from "./state/index.ts";
// State container base class
export { StateContainer } from "./state/state-container.ts";
// Whiteboard types
export type {
	WhiteboardCursor,
	WhiteboardSnapshot,
	WhiteboardUpdate,
} from "./types/entities/whiteboard.ts";

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
	TenantConfig,
	TokenProvider,
	TokenSet,
	Track,
	TrackKind,
} from "./types.ts";
// Export error code constants
export { ChalkErrorCode, err, ok } from "./types.ts";

// ============================================================================
// Token Provider Utility
// ============================================================================

export type {
	CreateTokenProviderConfig,
	TokenStorage,
} from "./token-provider.ts";
export { createTokenProvider } from "./token-provider.ts";

// ============================================================================
// Webhooks
// ============================================================================

export {
	chalkWebhookMiddleware,
	createWebhookHandler,
	type WebhookEvent,
	type WebhookHandlerOptions,
} from "./webhooks/index.ts";
export {
	WebhookError,
	WebhookMeeting,
	WebhookPayload,
	WebhookRecording,
	WebhookTranscript,
} from "./webhooks/schemas.ts";
