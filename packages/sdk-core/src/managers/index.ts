/**
 * Manager exports for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/managers
 */

// Chat Manager
export type { ChatManagerEvents, ChatState } from "./chat-manager";
export { ChatManager } from "./chat-manager";

// Interaction Manager
export type { ActiveReaction, InteractionManagerEvents, InteractionState } from "./interaction-manager";
export { InteractionManager } from "./interaction-manager";

// Recording Manager
export type { RecordingManagerEvents, RecordingState } from "./recording-manager";
export { RecordingManager } from "./recording-manager";

// Screen Share Manager
export type { ScreenShareManagerEvents, ScreenShareState } from "./screen-share-manager";
export { ScreenShareManager } from "./screen-share-manager";

// Screen Annotations Manager
export type { ScreenAnnotationsManagerEvents, ScreenAnnotationsState } from "./screen-annotations-manager";
export { ScreenAnnotationsManager } from "./screen-annotations-manager";

// UI Manager
export type { LayoutMode, Notification, NotificationSeverity, PanelType, UIManagerEvents, UIState } from "./ui-manager";
export { UIManager } from "./ui-manager";

// Whiteboard Manager
export type { WhiteboardManagerEvents, WhiteboardState } from "./whiteboard-manager";
export { WhiteboardManager } from "./whiteboard-manager";

// ============================================================================
// Effect-based services (new architecture)
// Re-export types for backwards compatibility
// ============================================================================

// ConferenceSession types (from Effect schemas)
export type { RoomState, RoomEvent as RoomManagerEvents } from "../effect/schemas/manager-state";

export type { JoinOptions, LeaveOptions } from "../effect/services/room-service";

// Participant types (from Effect schemas)
export type { ParticipantState, ParticipantEvent as ParticipantManagerEvents } from "../effect/schemas/manager-state";

// Media types (from Effect schemas)
export type { MediaState, MediaEvent as MediaManagerEvents } from "../effect/schemas/manager-state";
