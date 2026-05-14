import type { ParticipantState } from "@q9labs/chalk-core";

export type RoomParticipant = ParticipantState["participants"][number];
export type NativeMeetingPanelName = "chat" | "participants" | "settings" | "transcripts" | "whiteboard";

export interface NativeMeetingBottomDockProps {
  simulatorMediaDisabled: boolean;
  isMuted: boolean;
  isCameraOff: boolean;
  isHandRaised?: boolean;
  isScreenSharing?: boolean;
  unreadChatCount: number;
  participantCount?: number;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onToggleHand?: () => void;
  onToggleScreenShare?: () => void;
  onOpenChat: () => void;
  onOpenParticipants?: () => void;
  onOpenReactions?: () => void;
  onOpenMore: () => void;
  onLeave: () => void;
}

export interface NativeMeetingActionsSheetProps {
  visible: boolean;
  isHandRaised: boolean;
  isScreenSharing: boolean;
  chatEnabled: boolean;
  peopleEnabled: boolean;
  transcriptsEnabled: boolean;
  whiteboardEnabled?: boolean;
  screenShareEnabled: boolean;
  settingsEnabled: boolean;
  chatUnreadCount: number;
  participantCount: number;
  raisedHandCount: number;
  onClose: () => void;
  onInviteParticipants: () => void;
  onOpenChat: () => void;
  onOpenParticipants: () => void;
  onToggleHand: () => void;
  onOpenReactions: () => void;
  onOpenWhiteboard?: () => void;
  onToggleScreenShare: () => void;
  onOpenTranscripts: () => void;
  onOpenSettings: () => void;
  onLeaveMeeting: () => void;
}
