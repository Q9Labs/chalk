/**
 * @q9labs/chalk-react - React SDK for Chalk video conferencing
 *
 * @packageDocumentation
 * @module @q9labs/chalk-react
 */

// ============================================================================
// Re-export useful types from core
// ============================================================================

export type {
	// Entities
	ChalkError,
	ChatMessage,
	MediaDevice,
	Participant,
	Reaction,
	ReactionEmoji,
	Recording,
	RoomConfig,
	RoomInfo,
	RoomStatus,
	ScreenShareOptions,
	// Manager types
	RoomState,
	ParticipantState,
	MediaState,
	ScreenShareState,
	ChatState,
	RecordingState,
	InteractionState,
	ActiveReaction,
	UIState,
	LayoutMode,
	PanelType,
	Notification,
	NotificationSeverity,
	WhiteboardState,
	// Session
	ChalkSessionConfig,
	ChalkSessionEvents,
	JoinOptions,
	LeaveOptions,
} from "@q9labs/chalk-core";

// Re-export error codes
export { ChalkErrorCode } from "@q9labs/chalk-core";

// Re-export Room type for backward compatibility
export type { Room } from "@q9labs/chalk-core";

// ============================================================================
// Provider and Context
// ============================================================================

// New session-based provider
export {
	ChalkProvider,
	useSession,
	useChalkSession,
	type ChalkProviderProps,
} from "./context/index";

// Legacy provider for backward compatibility
export {
	ChalkProvider as LegacyChalkProvider,
	useChalk as useLegacyChalk,
	useRtkMeeting,
} from "./context.tsx";

// ============================================================================
// Hooks
// ============================================================================

// Namespace exports for discoverability
export * as hooks from "./hooks";

// Direct hook exports for convenience
export {
	// Room
	useChalk,
	useRoom,
	useConnection,
	// Participants
	useParticipants,
	useActiveSpeaker,
	// Stream
	useMedia,
	useDevices,
	useScreenShare,
	// Features
	useChat,
	useRecording,
	useWhiteboard,
	useInteractions,
	// UI
	useLayout,
	usePanels,
	useNotifications,
	// Utilities
	useSoundEffects,
	useKeyboardShortcuts,
	createMeetingShortcuts,
	useMediaQuery,
	useIsMobile,
	useIsTablet,
	useIsDesktop,
	usePrefersReducedMotion,
	usePrefersDarkMode,
	useAnnouncer,
	useTour,
	DEFAULT_MEETING_TOUR_STEPS,
	useTranscription,
	useWhiteboardPermissions,
	// Types
	type UseRoomReturn,
	type UseConnectionReturn,
	type UseParticipantsReturn,
	type UseActiveSpeakerReturn,
	type UseMediaReturn,
	type UseDevicesReturn,
	type UseScreenShareReturn,
	type UseChatReturn,
	type UseRecordingReturn,
	type UseWhiteboardReturn,
	type UseInteractionsReturn,
	type UseLayoutReturn,
	type UsePanelsReturn,
	type UseNotificationsReturn,
	type SoundEffect,
	type UseSoundEffectsOptions,
	type UseSoundEffectsReturn,
	type KeyboardShortcut,
	type UseKeyboardShortcutsOptions,
	type UseKeyboardShortcutsReturn,
	type AnnouncementPoliteness,
	type UseAnnouncerOptions,
	type UseAnnouncerReturn,
	type TourStep,
	type UseTourOptions,
	type UseTourReturn,
	type TranscriptEntry,
	type UseTranscriptionOptions,
	type UseTranscriptionReturn,
} from "./hooks";

// WhiteboardCursor re-exported from core
export type { WhiteboardCursor } from "@q9labs/chalk-core";

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
