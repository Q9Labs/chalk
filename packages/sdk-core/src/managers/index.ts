/**
 * Manager exports for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/managers
 */

export type { ChatManagerEvents, ChatState } from "./chat-manager";
export { ChatManager } from "./chat-manager";
export type {
	ActiveReaction,
	InteractionManagerEvents,
	InteractionState,
} from "./interaction-manager";
export { InteractionManager } from "./interaction-manager";
export type { MediaManagerEvents, MediaState } from "./media-manager";
export { MediaManager } from "./media-manager";
export type {
	ParticipantManagerEvents,
	ParticipantState,
} from "./participant-manager";
export { ParticipantManager } from "./participant-manager";
export type {
	RecordingManagerEvents,
	RecordingState,
} from "./recording-manager";
export { RecordingManager } from "./recording-manager";
export type {
	JoinOptions,
	LeaveOptions,
	RoomManagerEvents,
	RoomState,
} from "./room-manager";
// Managers
export { RoomManager } from "./room-manager";
export type {
	ScreenShareManagerEvents,
	ScreenShareState,
} from "./screen-share-manager";
export { ScreenShareManager } from "./screen-share-manager";
export type {
	LayoutMode,
	Notification,
	NotificationSeverity,
	PanelType,
	UIManagerEvents,
	UIState,
} from "./ui-manager";
export { UIManager } from "./ui-manager";
export type {
	WhiteboardManagerEvents,
	WhiteboardState,
} from "./whiteboard-manager";
export { WhiteboardManager } from "./whiteboard-manager";
