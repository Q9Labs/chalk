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
import type { ConferenceViewProps } from "../ConferenceView";
import type { ConferenceViewAction } from "./types";
import { useConferenceViewCapabilities } from "./useConferenceViewCapabilities";
import { useConferenceViewChat } from "./useConferenceViewChat";
import { deriveConnectionStatus } from "../ConnectionStatusBanner";
import { useConferenceViewDiagnostics } from "./useConferenceViewDiagnostics";
import { useConferenceViewDerived } from "./useConferenceViewDerived";
import { useConferenceViewInteractions } from "./useConferenceViewInteractions";
import { useConferenceViewMedia } from "./useConferenceViewMedia";
import { useConferenceViewPanels } from "./useConferenceViewPanels";
import { useConferenceViewParticipants } from "./useConferenceViewParticipants";

export function useConferenceViewController({ roomName, meetingLink, features, onLeave, onEndForAll, onDiagnosticsChange, pickChatAttachments, initialState, controlledState }: ConferenceViewProps) {
  const session = useChalkSession();
  const telemetry = useTelemetry();
  const snapshot = useChalkSnapshot();
  const media = useMedia();
  const participants = useMeetingParticipants();
  const room = useRoom();
  const chat = useChat();
  const interactions = useInteractions();
  const screenShare = useScreenShare();

  const run = useCallback(async (action: ConferenceViewAction) => {
    try {
      await action();
    } catch (cause) {
      Alert.alert("Action failed", cause instanceof Error ? cause.message : "Chalk could not complete the action.");
    }
  }, []);
  const commands = useMemo(() => createNativeRoomActionCommands(session), [session]);
  const capabilities = useConferenceViewCapabilities({ features, session, snapshot, chat, interactions });
  const roomMedia = useConferenceViewMedia({ media, screenShare, run });
  const roomInteractions = useConferenceViewInteractions({ interactions, run });
  const panels = useConferenceViewPanels({ roomName, meetingLink, canWhiteboard: capabilities.canWhiteboard, isHost: capabilities.isHost, session, room, telemetry, onLeave, onEndForAll, run, initialState, controlledState });
  const roomChat = useConferenceViewChat({ session, chat, pickChatAttachments, run });
  const roomParticipants = useConferenceViewParticipants({ isHost: capabilities.isHost, snapshot, session, participants, commands, run });
  const derived = useConferenceViewDerived({
    participants: participants.participants,
    localParticipant: participants.localParticipant,
    screenShare,
    isWhiteboardOpen: panels.whiteboard.isOpen,
  });
  const diagnostics = useConferenceViewDiagnostics({
    capabilities,
    participants: roomParticipants,
    chat,
    interactions: roomInteractions,
    screenShare,
    onDiagnosticsChange,
  });
  const connectionStatus = deriveConnectionStatus(snapshot);
  const retryConnection = useCallback(() => {
    if (commands.retryConnection) void run(commands.retryConnection);
  }, [commands, run]);

  return {
    simulatorMediaDisabled: isIosSimulator(),
    roomName: roomName || room.roomName || "Space",
    isHost: capabilities.isHost,
    panel: panels.panel,
    selfName: roomParticipants.selfName,
    isMuted: roomMedia.isMuted,
    isCameraOff: roomMedia.isCameraOff,
    handRaised: roomInteractions.handRaised,
    raisedHandCount: roomInteractions.raisedHandCount,
    activeReactions: roomInteractions.activeReactions,
    secondsElapsed: panels.secondsElapsed,
    formattedDuration: panels.formattedDuration,
    actionsOpen: panels.actionsOpen,
    reactionPickerOpen: panels.reactionPickerOpen,
    settingsOpen: panels.settingsOpen,
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
    connectionStatus,
    retryConnection,
    participants,
    chat,
    interactions,
    screenShare,
    layout: panels.layout,
    whiteboard: panels.whiteboard,
    derived,
    setActionsOpen: panels.setActionsOpen,
    setReactionPickerOpen: panels.setReactionPickerOpen,
    setSettingsOpen: panels.setSettingsOpen,
    setChatDraft: roomChat.setChatDraft,
    handleLeave: panels.handleLeave,
    openPanel: panels.openPanel,
    closePanel: panels.closePanel,
    handleInviteParticipants: panels.handleInviteParticipants,
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
