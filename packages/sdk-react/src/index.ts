/**
 * @q9labs/chalk-react - React SDK for Chalk video conferencing
 *
 * @packageDocumentation
 * @module @q9labs/chalk-react
 */

// ============================================================================
// Re-export useful types from core
// ============================================================================

// Re-export ConferenceSession type for backward compatibility
export type {
  ActiveReaction,
  // Entities
  ChalkError,
  ChalkIncident,
  ChalkIncidentBreadcrumb,
  ChalkIncidentConfig,
  ChalkIncidentContext,
  ChalkIncidentInput,
  ChalkIncidentSeverity,
  ChalkIncidentSource,
  ChalkPostHogClient,
  ChalkPostHogConfig,
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
  ConferenceSession,
  JoinSessionConfig,
  SessionInfo,
  // Manager types
  RoomState,
  SessionConnectionState,
  ScreenShareOptions,
  ScreenShareState,
  UIState,
  VideoBackgroundEffect,
  WhiteboardState,
  HttpIncidentReporterConfig,
  IncidentReporter,
} from "@q9labs/chalk-core";
// Re-export error codes
export { ChalkErrorCode } from "@q9labs/chalk-core";

// Re-export wide events (replaces old logging utilities)
export { wideEvents, configureWideEvents, createBrowserIncidentContext, createHttpIncidentReporter, createSupportCode, type WideEvent, type WideEventConfig } from "@q9labs/chalk-core";
export { chalkDebugCollector, type ChalkDebugConsoleRecord, type ChalkDebugFetchRecord, type ChalkDebugRuntimeErrorRecord, type ChalkDebugSnapshot, type ChalkDebugWebSocketRecord } from "@q9labs/chalk-core";

// ============================================================================
// Provider and Context
// ============================================================================

// Session-based provider
export { ChalkProvider, type ChalkProviderProps, useChalkSession, useSession } from "./context/index";

// ============================================================================
// Hooks
// ============================================================================

// Whiteboard types re-exported from core
export type { WhiteboardCursor, WhiteboardUpdate } from "@q9labs/chalk-core";
// Namespace exports for discoverability
export * as hooks from "./hooks";
// Direct hook exports for convenience
export {
  type ChalkHapticInput,
  type ChalkHapticPreset,
  type ChalkHapticTriggerOptions,
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
  type UseHapticsOptions,
  type UseHapticsReturn,
  type UseInteractionsReturn,
  type UseKeyboardShortcutsOptions,
  type UseKeyboardShortcutsReturn,
  type UseLayoutReturn,
  type UseMediaReturn,
  type UseNotificationsReturn,
  type UsePanelsReturn,
  type PwaInstallPlatform,
  type UsePictureInPictureOptions,
  type UsePictureInPictureReturn,
  usePwaInstall,
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
  // ConferenceSession
  useChalk,
  // Features
  useChat,
  useConnection,
  useDevices,
  useHaptics,
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
  usePictureInPicture,
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
  useWhatsNew,
  type UseWhatsNewReturn,
  type UseWhatsNewOptions,
  type WhatsNewData,
  // Logging
  useLogger,
  type UseLoggerReturn,
  // Per-participant volume
  useParticipantVolume,
  type UseParticipantVolumeReturn,
} from "./hooks";

// ============================================================================
// Components
// ============================================================================

export * from "./components";
export type { MeetingJoinedData, MeetingEndData } from "./components/full/VideoConference";

// ============================================================================
// Utils
// ============================================================================

export * from "./utils";

// Styles - export path for consumers to import
export const CHALK_STYLES_PATH = "@q9labs/chalk-react/styles.css";

// ============================================================================
// Assets
// ============================================================================

export { SOUND_FILES, LOGO_FILES } from "./assets";

/** CDN URL for Excalidraw CSS (used by WhiteboardPanel by default) */
export const EXCALIDRAW_CSS_CDN = "https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.18.0/dist/prod/index.css";
