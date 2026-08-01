import { useCallback, useMemo } from "react";
import { Alert } from "react-native";

import { useChalkSession, useTelemetry } from "../../context/chalk-provider";
import { useChat } from "../../hooks/useChat";
import { useInteractions } from "../../hooks/useInteractions";
import { useMedia } from "../../hooks/useMedia";
import { useMeetingParticipants } from "../../hooks/useMeetingParticipants";
import { useRoom } from "../../hooks/useRoom";
import { useScreenShare } from "../../hooks/useScreenShare";
import { useChalkSnapshot } from "../../hooks/useChalkSnapshot";
import { createNativeRoomActionCommands } from "../../room-actions/native-room-actions";
import { isIosSimulator } from "../../utils/ios-simulator";
import type { MeetingRoomProps } from "../MeetingRoom";
import type { MeetingRoomAction } from "./types";
import { useMeetingRoomCapabilities } from "./useMeetingRoomCapabilities";
import { useMeetingRoomChat } from "./useMeetingRoomChat";
import { useMeetingRoomDiagnostics } from "./useMeetingRoomDiagnostics";
import { useMeetingRoomDerived } from "./useMeetingRoomDerived";
import { useMeetingRoomInteractions } from "./useMeetingRoomInteractions";
import { useMeetingRoomMedia } from "./useMeetingRoomMedia";
import { useMeetingRoomPanels } from "./useMeetingRoomPanels";
import { useMeetingRoomParticipants } from "./useMeetingRoomParticipants";

export function useMeetingRoomController({ roomName, meetingLink, features, onLeave, onEndForAll, onDiagnosticsChange, pickChatAttachments }: MeetingRoomProps) {
  const session = useChalkSession();
  const telemetry = useTelemetry();
  const snapshot = useChalkSnapshot();
  const media = useMedia();
  const participants = useMeetingParticipants();
  const room = useRoom();
  const chat = useChat();
  const interactions = useInteractions();
  const screenShare = useScreenShare();

  const run = useCallback(async (action: MeetingRoomAction) => {
    try {
      await action();
    } catch (cause) {
      Alert.alert("Action failed", cause instanceof Error ? cause.message : "Chalk could not complete the action.");
    }
  }, []);
  const commands = useMemo(() => createNativeRoomActionCommands(session), [session]);
  const capabilities = useMeetingRoomCapabilities({ features, session, snapshot, chat, interactions });
  const roomMedia = useMeetingRoomMedia({ media, screenShare, run });
  const roomInteractions = useMeetingRoomInteractions({ interactions, run });
  const roomPanels = useMeetingRoomPanels({ roomName, meetingLink, canWhiteboard: capabilities.canWhiteboard, isHost: capabilities.isHost, session, room, telemetry, onLeave, onEndForAll, run });
  const roomChat = useMeetingRoomChat({ session, chat, pickChatAttachments, run });
  const roomParticipants = useMeetingRoomParticipants({ isHost: capabilities.isHost, snapshot, session, participants, commands, run });
  const derived = useMeetingRoomDerived({
    participants: participants.participants,
    localParticipant: participants.localParticipant,
    screenShare,
    isWhiteboardOpen: roomPanels.whiteboard.isOpen,
  });
  const diagnostics = useMeetingRoomDiagnostics({
    capabilities,
    participants: roomParticipants,
    chat,
    interactions: roomInteractions,
    screenShare,
    onDiagnosticsChange,
  });

  return {
    simulatorMediaDisabled: isIosSimulator(),
    roomName: roomName || room.roomName || "Meeting",
    isHost: capabilities.isHost,
    panel: roomPanels.panel,
    selfName: roomParticipants.selfName,
    isMuted: roomMedia.isMuted,
    isCameraOff: roomMedia.isCameraOff,
    handRaised: roomInteractions.handRaised,
    raisedHandCount: roomInteractions.raisedHandCount,
    activeReactions: roomInteractions.activeReactions,
    secondsElapsed: roomPanels.secondsElapsed,
    formattedDuration: roomPanels.formattedDuration,
    actionsOpen: roomPanels.actionsOpen,
    reactionPickerOpen: roomPanels.reactionPickerOpen,
    chatDraft: roomChat.chatDraft,
    chatAttachments: roomChat.chatAttachments,
    chatAttachmentsLoading: roomChat.chatAttachmentsLoading,
    participantCount: roomParticipants.participantCount,
    canChat: capabilities.canChat,
    canParticipants: capabilities.canParticipants,
    canScreenShare: capabilities.canScreenShare,
    canReactions: capabilities.canReactions,
    canHandRaise: capabilities.canHandRaise,
    canWhiteboard: capabilities.canWhiteboard,
    canManageAdmission: capabilities.canManageAdmission,
    canSetParticipantRole: capabilities.canSetParticipantRole,
    canTransferHost: capabilities.canTransferHost,
    canRequestMedia: capabilities.canRequestMedia,
    canMuteParticipants: capabilities.canMuteParticipants,
    canRemoveParticipants: capabilities.canRemoveParticipants,
    canStopParticipantCamera: capabilities.canStopParticipantCamera,
    canStopParticipantScreenShare: capabilities.canStopParticipantScreenShare,
    admissionRequests: roomParticipants.admissionRequests,
    roomDiagnostics: diagnostics.roomDiagnostics,
    participants,
    chat,
    interactions,
    screenShare,
    layout: roomPanels.layout,
    whiteboard: roomPanels.whiteboard,
    derived,
    setActionsOpen: roomPanels.setActionsOpen,
    setReactionPickerOpen: roomPanels.setReactionPickerOpen,
    setChatDraft: roomChat.setChatDraft,
    handleLeave: roomPanels.handleLeave,
    openPanel: roomPanels.openPanel,
    closePanel: roomPanels.closePanel,
    handleInviteParticipants: roomPanels.handleInviteParticipants,
    toggleAudio: roomMedia.toggleAudio,
    toggleVideo: roomMedia.toggleVideo,
    toggleScreenShare: roomMedia.toggleScreenShare,
    toggleHand: roomInteractions.toggleHand,
    sendReaction: roomInteractions.sendReaction,
    sendChatMessage: roomChat.sendChatMessage,
    pickChatAttachments: roomChat.pickChatAttachments,
    removeChatAttachment: roomChat.removeChatAttachment,
    openChatAttachment: roomChat.openChatAttachment,
    markChatMessageVisible: roomChat.markChatMessageVisible,
    admitParticipant: roomParticipants.admitParticipant,
    denyAdmission: roomParticipants.denyAdmission,
    setParticipantRole: roomParticipants.setParticipantRole,
    transferHost: roomParticipants.transferHost,
    removeParticipant: roomParticipants.removeParticipant,
    muteParticipant: roomParticipants.muteParticipant,
    requestUnmuteParticipant: roomParticipants.requestUnmuteParticipant,
    requestStartParticipantCamera: roomParticipants.requestStartParticipantCamera,
    stopParticipantCamera: roomParticipants.stopParticipantCamera,
    stopParticipantScreenShare: roomParticipants.stopParticipantScreenShare,
  };
}
