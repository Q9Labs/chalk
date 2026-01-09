/**
 * @q9labs/chalk-react - React SDK for Chalk video conferencing
 *
 * @packageDocumentation
 * @module @q9labs/chalk-react
 */

// ============================================================================
// Re-export useful types from core
// ============================================================================

// Re-export Room type for backward compatibility
export type {
	ActiveReaction,
	// Entities
	ChalkError,
	// Session
	ChalkSessionConfig,
	ChalkSessionEvents,
	ChatMessage,
	ChatState,
	InteractionState,
	JoinOptions,
	LayoutMode,
	LeaveOptions,
	MediaDevice,
	MediaState,
	Notification,
	NotificationSeverity,
	PanelType,
	Participant,
	ParticipantState,
	Reaction,
	ReactionEmoji,
	Recording,
	RecordingState,
	Room,
	RoomConfig,
	RoomInfo,
	// Manager types
	RoomState,
	RoomStatus,
	ScreenShareOptions,
	ScreenShareState,
	UIState,
	WhiteboardState,
} from "@q9labs/chalk-core";
// Re-export error codes
export { ChalkErrorCode } from "@q9labs/chalk-core";

// Re-export logging utilities
export {
	createLogger,
	configureLogger,
	initLogging,
	isLoggingEnabled,
	type Logger,
	type LogLevel,
	type LoggerConfig,
	type LogEntry,
} from "@q9labs/chalk-core";

// ============================================================================
// Provider and Context
// ============================================================================

// Session-based provider
export {
	ChalkProvider,
	type ChalkProviderProps,
	useChalkSession,
	useSession,
} from "./context/index";

// ============================================================================
// Hooks
// ============================================================================

// Whiteboard types re-exported from core
export type { WhiteboardCursor, WhiteboardUpdate } from "@q9labs/chalk-core";
// Namespace exports for discoverability
export * as hooks from "./hooks";
// Direct hook exports for convenience
export {
	type AnnouncementPoliteness,
	createMeetingShortcuts,
	DEFAULT_MEETING_TOUR_STEPS,
	type KeyboardShortcut,
	type SoundEffect,
	type TourStep,
	type TranscriptEntry,
	type UseActiveSpeakerReturn,
	type UseAnnouncerOptions,
	type UseAnnouncerReturn,
	type UseChatReturn,
	type UseConnectionReturn,
	type UseDevicesReturn,
	type UseInteractionsReturn,
	type UseKeyboardShortcutsOptions,
	type UseKeyboardShortcutsReturn,
	type UseLayoutReturn,
	type UseMediaReturn,
	type UseNotificationsReturn,
	type UsePanelsReturn,
	type UseParticipantsReturn,
	type UseRecordingReturn,
	// Types
	type UseRoomReturn,
	type UseScreenShareReturn,
	type UseSoundEffectsOptions,
	type UseSoundEffectsReturn,
	type UseTourOptions,
	type UseTourReturn,
	type UseTranscriptionOptions,
	type UseTranscriptionReturn,
	type UseWhiteboardPermissionsReturn,
	type UseWhiteboardReturn,
	useActiveSpeaker,
	useAnnouncer,
	// Room
	useChalk,
	// Features
	useChat,
	useConnection,
	useDevices,
	useInteractions,
	useIsDesktop,
	useIsMobile,
	useIsTablet,
	useKeyboardShortcuts,
	// UI
	useLayout,
	// Stream
	useMedia,
	useMediaQuery,
	useNotifications,
	usePanels,
	// Participants
	useParticipants,
	usePrefersDarkMode,
	usePrefersReducedMotion,
	useRecording,
	useRoom,
	useScreenShare,
	// Utilities
	useSoundEffects,
	useTour,
	useTranscription,
	useWhiteboard,
	useWhiteboardPermissions,
	// Logging
	useLogger,
	type UseLoggerReturn,
} from "./hooks";

// ============================================================================
// Components
// ============================================================================

export * from "./components";

// ============================================================================
// Utils
// ============================================================================

export * from "./utils";

// Styles - export path for consumers to import
export const CHALK_STYLES_PATH = "@q9labs/chalk-react/dist/styles/base.css";
