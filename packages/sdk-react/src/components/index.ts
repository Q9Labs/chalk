/**
 * React components for Chalk video conferencing
 *
 * Components are organized in three layers:
 * - atomic: Building blocks (VideoTile, Avatar, Button, etc.)
 * - composite: Assembled components (VideoGrid, ControlBar, ChatPanel, etc.)
 * - full: Complete experiences (MeetingRoom, PreJoinLobby, etc.)
 */

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
} from "./composite";

// Full integration components
export * from "./full";

// Lazy loaded components
export * from "./lazy";
