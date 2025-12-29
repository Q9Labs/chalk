/**
 * React components for Chalk video conferencing
 * 
 * Components are organized in three layers:
 * - atomic: Building blocks (VideoTile, Avatar, Button, etc.)
 * - composite: Assembled components (VideoGrid, ControlBar, ChatPanel, etc.)
 * - full: Complete experiences (MeetingRoom, PreJoinLobby, etc.)
 */

// Atomic components - all exports
export * from './atomic';

// Composite components - selective exports to avoid type collisions
export {
  NotificationStack,
  ConnectionLostOverlay,
  MeetingHeader,
  InviteModal,
  MessageBubble,
  TypingIndicator,
  PinnedMessageBanner,
  TourOverlay,
  ParticipantList,
  ChatPanel,
  TranscriptionPanel,
  SettingsPanel,
  WaitingRoom,
  DeviceSelector,
  BackgroundEffectsPicker,
  NoiseSuppressionToggle,
  VideoGrid,
  ScreenShareView,
  LayoutSwitcher,
  MediaPreview,
  ControlBar,
  MobileControlSheet,
  ReactionPicker,
  RecordingControls,
} from './composite';

export type {
  NotificationStackProps,
  Notification,
  ConnectionLostOverlayProps,
  MeetingHeaderProps,
  InviteModalProps,
  MessageBubbleProps,
  TypingIndicatorProps,
  PinnedMessageBannerProps,
  TourOverlayProps,
  ParticipantListProps,
  ParticipantListParticipant,
  ChatPanelProps,
  TranscriptionPanelProps,
  SettingsPanelProps,
  WaitingRoomProps,
  WaitingParticipant,
  DeviceSelectorProps,
  BackgroundEffectsPickerProps,
  BackgroundEffect,
  NoiseSuppressionToggleProps,
  VideoGridProps,
  Participant,
  ScreenShareViewProps,
  LayoutSwitcherProps,
  MediaPreviewProps,
  ControlBarProps,
  ControlBarButton,
  MobileControlSheetProps,
  ReactionPickerProps,
  RecordingControlsProps,
} from './composite';

// Full integration components
export * from './full';
