import type { NativeParticipantState } from "../../ui/native-types";

export type RoomParticipant = NativeParticipantState["participants"][number];
export type MeetingPanelName = "chat" | "participants" | "whiteboard";
export type ConferenceViewAction = () => unknown | Promise<unknown>;
export type ConferenceViewActionRunner = (action: ConferenceViewAction) => Promise<void>;

export interface MeetingBottomDockProps {
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
  onOpenChat?: () => void;
  onOpenParticipants?: () => void;
  onOpenReactions?: () => void;
  onOpenMore: () => void;
  onLeave: () => void;
}
