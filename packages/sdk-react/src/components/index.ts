/**
 * React components for Chalk video conferencing
 *
 * Components are organized in three layers:
 * - atomic: Building blocks (VideoTile, Avatar, Button, etc.)
 * - composable (alias: composite): Assembled components (VideoGrid, ControlBar, ChatPanel, etc.)
 * - turnkey (alias: full): Complete experiences (VideoConference, MeetingRoom, etc.)
 *
 * Consumer usage levels:
 * - Level 0 (Turnkey): <VideoConference roomId="abc" userName="John" />
 * - Level 1 (Composable): <composable.VideoGrid />, <composable.ControlBar />
 * - Level 2 (Atomic): <atomic.VideoTile participant={p} />, <atomic.Avatar name="John" />
 */

// ============================================================================
// Namespace exports for discoverability
// ============================================================================

// Level 2: Atomic - Building blocks with explicit props
export * as atomic from "./atomic";

// Level 1: Composable - Context-connected components
export * as composable from "./composite";
// Level 0: Turnkey - Complete, zero-config experiences
export * as turnkey from "./full";

// shadcn/ui components
export * as ui from "./ui";

// ============================================================================
// Direct exports for convenience
// ============================================================================

// Atomic components - all exports
export * from "./atomic";
export type {
  BackgroundEffect,
  BackgroundEffectsPickerProps,
  ChatPanelProps,
  ConnectionLostOverlayProps,
  ControlBarButton,
  ControlBarProps,
  DeviceSelectorProps,
  InviteModalProps,
  LayoutSwitcherProps,
  MediaPreviewProps,
  MeetingHeaderProps,
  MessageBubbleProps,
  MobileControlSheetProps,
  NoiseSuppressionToggleProps,
  Notification,
  NotificationStackProps,
  Participant,
  ParticipantListParticipant,
  ParticipantListProps,
  PinnedMessageBannerProps,
  ReactionPickerProps,
  RecordingControlsProps,
  ScreenShareViewProps,
  SettingsPanelProps,
  // SidePanelsWrapperProps removed - component does not exist
  TourOverlayProps,
  TranscriptionPanelProps,
  WhatsNewDialogProps,
  TypingIndicatorProps,
  VideoGridProps,
  WaitingParticipant,
  WaitingRoomProps,
} from "./composite";
// Composite components - selective exports to avoid type collisions
export {
  BackgroundEffectsPicker,
  ChatPanel,
  ConnectionLostOverlay,
  ControlBar,
  DeviceSelector,
  InviteModal,
  LayoutSwitcher,
  MediaPreview,
  MeetingHeader,
  MessageBubble,
  MobileControlSheet,
  NoiseSuppressionToggle,
  NotificationStack,
  ParticipantList,
  PinnedMessageBanner,
  ReactionPicker,
  RecordingControls,
  ScreenShareView,
  SettingsPanel,
  TourOverlay,
  TranscriptionPanel,
  TypingIndicator,
  VideoGrid,
  WaitingRoom,
  WhatsNewDialog,
} from "./composite";
export { EndScreen } from "./full/EndScreen";
export { GuidedTour } from "./full/GuidedTour";
export type { LoadingScreenProps } from "./full/LoadingScreen";
export { LoadingScreen } from "./full/LoadingScreen";
export type { MeetingRoomProps } from "./full/MeetingRoom";
export { MeetingRoom } from "./full/MeetingRoom";
export type { JoinSettings, PreJoinLobbyProps } from "./full/PreJoinLobby";
export { PreJoinLobby } from "./full/PreJoinLobby";
export type { VideoConferenceProps } from "./full/VideoConference";
// Full integration components
export { VideoConference } from "./full/VideoConference";

// Lazy loaded components
export * from "./lazy";
