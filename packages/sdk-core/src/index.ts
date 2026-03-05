/**
 * @q9labs/chalk-core - Core SDK for Chalk video conferencing
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core
 *
 * @example
 * ```ts
 * import { ConferenceClient } from '@q9labs/chalk-core';
 *
 * const client = new ConferenceClient({ token: 'jwt_xxx' });
 * const room = await client.joinSession('room_123', {
 *   displayName: 'John Doe',
 *   audio: true,
 *   video: true,
 * });
 *
 * room.on('participant.joined', (p) => console.log(`${p.displayName} joined`));
 * ```
 */

// API client (for React Native SDK which uses its own RTK integration)
export { APIClient } from "./api-client.ts";
// Main client
export { ConferenceClient } from "./client.ts";
// Event emitter (for advanced use cases)
export { EventEmitter } from "./events.ts";
// ConferenceSession
export {
	ConferenceSession,
	type ConferenceSessionEvents,
	type Transcript,
} from "./room.ts";
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

// WebSocket schema maps (runtime validation + inferred types)
export {
	WSOutboundPayloadSchemas,
	type WSOutboundMessageType,
} from "./effect/schemas/index.ts";
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

export {
	createAxiomWideEventsHandler,
	type AxiomWideEventsConfig,
	type AxiomWideEventsHandler,
} from "./wide-events/axiom.ts";
export {
	createBrowserIncidentContext,
	createHttpIncidentReporter,
	createSupportCode,
	type ChalkIncident,
	type ChalkIncidentBreadcrumb,
	type ChalkIncidentConfig,
	type ChalkIncidentContext,
	type ChalkIncidentInput,
	type ChalkIncidentSeverity,
	type ChalkIncidentSource,
	type HttpIncidentReporterConfig,
	type IncidentReporter,
} from "./incident.ts";
export type {
	ChalkPostHogClient,
	ChalkPostHogConfig,
} from "./posthog.ts";

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
	ConferenceClientConfig,
	ChalkError,
	ChalkEventType,
	ChatMessage,
	CreateRoomResponse,
	Err,
	JoinSessionResponse,
	JoinSessionResult,
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
	JoinSessionConfig,
	SessionInfo,
	SessionConnectionState,
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
