import type { NativeParticipantState } from "../../ui/native-types";

export type SpaceParticipant = NativeParticipantState["participants"][number];
export type SpacePanelName = "chat" | "participants" | "settings" | "whiteboard";
export type SpaceViewAction = () => unknown | Promise<unknown>;
export type SpaceViewActionRunner = (action: SpaceViewAction) => Promise<void>;

export interface SpaceBottomDockProps {
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
