/**
 * Chalk React SDK Hooks
 *
 * Hooks are organized by namespace for discoverability:
 * - hooks.room.* - Room and connection management
 * - hooks.participants.* - Participant list and active speaker
 * - hooks.stream.* - Media, devices, and screen share
 * - hooks.features.* - Chat, recording, whiteboard, interactions
 * - hooks.ui.* - Layout, panels, notifications
 * - hooks.utilities.* - Sound effects, keyboard shortcuts, media queries
 *
 * Direct exports are also available for convenience:
 * - useChalk, useRoom, useParticipants, useMedia, etc.
 */

// ============================================================================
// Namespace exports
// ============================================================================

export * as features from "./features";
export * as participants from "./participants";
export * as room from "./room";
export * as stream from "./stream";
export * as ui from "./ui";
export * as utilities from "./utilities";

// ============================================================================
// Direct exports for convenience
// ============================================================================

// Context (from new ChalkProvider)
export { useChalkSession, useSession } from "../context/chalk-provider";
// Features
export { type UseChatReturn, useChat } from "./features/useChat";
export {
	type UseInteractionsReturn,
	useInteractions,
} from "./features/useInteractions";
export { type UseRecordingReturn, useRecording } from "./features/useRecording";
export {
	type UseTranscriptsReturn,
	useTranscripts,
} from "./features/useTranscripts";
export {
	type UseWhiteboardReturn,
	useWhiteboard,
} from "./features/useWhiteboard";
export {
	type UseActiveSpeakerReturn,
	useActiveSpeaker,
} from "./participants/useActiveSpeaker";
// Participants
export {
	type UseParticipantsReturn,
	useParticipants,
} from "./participants/useParticipants";
// Room
export { useChalk } from "./room/useChalk";
export { type UseConnectionReturn, useConnection } from "./room/useConnection";
export { type UseRoomReturn, useRoom } from "./room/useRoom";
export { type UseDevicesReturn, useDevices } from "./stream/useDevices";
// Stream
export { type UseMediaReturn, useMedia } from "./stream/useMedia";
export {
	type UseScreenShareReturn,
	useScreenShare,
} from "./stream/useScreenShare";

// UI
export { type UseLayoutReturn, useLayout } from "./ui/useLayout";
export {
	type UseNotificationsReturn,
	useNotifications,
} from "./ui/useNotifications";
export { type UsePanelsReturn, usePanels } from "./ui/usePanels";
export {
	type UseWhatsNewReturn,
	type UseWhatsNewOptions,
	type WhatsNewData,
	useWhatsNew,
} from "./ui/useWhatsNew";
export {
	type UseParticipantVolumeReturn,
	useParticipantVolume,
} from "./ui/useParticipantVolume";
export {
	type AnnouncementPoliteness,
	type UseAnnouncerOptions,
	type UseAnnouncerReturn,
	useAnnouncer,
} from "./useAnnouncer";
export {
	createMeetingShortcuts,
	type KeyboardShortcut,
	type UseKeyboardShortcutsOptions,
	type UseKeyboardShortcutsReturn,
	useKeyboardShortcuts,
} from "./useKeyboardShortcuts";
export {
	useIsDesktop,
	useIsMobile,
	useIsTablet,
	useMediaQuery,
	usePrefersDarkMode,
	usePrefersReducedMotion,
} from "./useMediaQuery";
// Utilities
export {
	type SoundEffect,
	type UseSoundEffectsOptions,
	type UseSoundEffectsReturn,
	useSoundEffects,
} from "./useSoundEffects";
export {
	DEFAULT_MEETING_TOUR_STEPS,
	type TourStep,
	type UseTourOptions,
	type UseTourReturn,
	useTour,
} from "./useTour";
export {
	type TranscriptEntry,
	type UseTranscriptionOptions,
	type UseTranscriptionReturn,
	useTranscription,
} from "./useTranscription";
export {
	type UseWhiteboardPermissionsReturn,
	useWhiteboardPermissions,
} from "./useWhiteboardPermissions";
export { type UseLoggerReturn, useLogger } from "./utilities/useLogger";
