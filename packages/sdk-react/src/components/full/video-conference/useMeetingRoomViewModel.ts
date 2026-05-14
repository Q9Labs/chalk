import type { ChatAttachment, ChatReadReceipt, Participant } from "@q9labs/chalk-core";
import { useMemo } from "react";

interface ChatMessageLike {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: Date;
  attachments?: ChatAttachment[];
  readBy?: ChatReadReceipt[];
}

interface MediaLike {
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
  selectedSpeaker: string | null;
}

interface ScreenShareLike {
  isLocalSharing: boolean;
  videoTrack?: MediaStreamTrack | null;
}

interface InteractionsLike {
  isHandRaised: boolean;
  raisedHands: readonly string[];
}

export interface UseMeetingRoomViewModelParams {
  participants: readonly Participant[];
  activeSpeakerId?: string;
  userName: string;
  media: MediaLike;
  screenShare: ScreenShareLike;
  interactions: InteractionsLike;
  messages: readonly ChatMessageLike[];
  localParticipantId?: string;
  defaultsLayout?: "grid" | "spotlight" | "sidebar";
  layout: string;
  lobbySelectedSpeaker?: string;
  localRole?: string;
}

export interface UseMeetingRoomViewModelReturn {
  allParticipants: Array<{
    id: string;
    displayName: string;
    isLocal: boolean;
    isSpeaking: boolean;
    isMuted: boolean;
    isVideoEnabled: boolean;
    isScreenSharing: boolean;
    isHandRaised: boolean;
    connectionQuality: 1 | 2 | 3 | 4 | undefined;
    videoTrack?: MediaStreamTrack;
    audioTrack?: MediaStreamTrack;
    screenShareTrack?: MediaStreamTrack;
    screenShareAudioTrack?: MediaStreamTrack;
    role?: "host" | "co-host" | "participant";
  }>;
  localMeetingParticipant: {
    id: string;
    displayName: string;
    isLocal: boolean;
    isSpeaking: boolean;
    isMuted: boolean;
    isVideoEnabled: boolean;
    isScreenSharing: boolean;
    isHandRaised: boolean;
    screenShareTrack?: MediaStreamTrack;
  };
  chatMessages: Array<{
    id: string;
    senderId: string;
    senderName: string;
    content: string;
    timestamp: Date;
    isLocal: boolean;
    attachments?: ChatAttachment[];
    readBy?: ChatReadReceipt[];
  }>;
  meetingLayout: "grid" | "spotlight" | "sidebar";
  selectedAudioOutput?: string;
  canManageParticipants: boolean;
}

export function useMeetingRoomViewModel({ participants, activeSpeakerId, userName, media, screenShare, interactions, messages, localParticipantId, defaultsLayout, layout, lobbySelectedSpeaker, localRole }: UseMeetingRoomViewModelParams): UseMeetingRoomViewModelReturn {
  const raisedHandIds = useMemo(() => new Set(interactions.raisedHands), [interactions.raisedHands]);

  const allParticipants = useMemo(
    () =>
      participants.map((participant) => ({
        id: participant.id,
        displayName: participant.displayName,
        isLocal: participant.isLocal,
        isSpeaking: activeSpeakerId === participant.id,
        isMuted: !participant.audioEnabled,
        isVideoEnabled: participant.videoEnabled,
        isScreenSharing: participant.isScreenSharing,
        isHandRaised: participant.handRaised || raisedHandIds.has(participant.id),
        connectionQuality: participant.connectionQuality as 1 | 2 | 3 | 4 | undefined,
        videoTrack: participant.videoTrack,
        audioTrack: participant.audioTrack,
        screenShareTrack: participant.screenShareTrack,
        screenShareAudioTrack: participant.screenShareAudioTrack,
        role: participant.role as "host" | "co-host" | "participant" | undefined,
      })),
    [participants, activeSpeakerId, raisedHandIds],
  );

  const localMeetingParticipant = useMemo(
    () =>
      allParticipants.find((participant) => participant.isLocal) ?? {
        id: "local",
        displayName: userName,
        isLocal: true,
        isSpeaking: false,
        isMuted: !media.isAudioEnabled,
        isVideoEnabled: media.isVideoEnabled,
        isScreenSharing: screenShare.isLocalSharing,
        isHandRaised: interactions.isHandRaised || (localParticipantId ? raisedHandIds.has(localParticipantId) : false),
        screenShareTrack: screenShare.videoTrack ?? undefined,
      },
    [allParticipants, userName, localParticipantId, media.isAudioEnabled, media.isVideoEnabled, screenShare.isLocalSharing, screenShare.videoTrack, interactions.isHandRaised, raisedHandIds],
  );

  const chatMessages = useMemo(() => {
    const localChatSenderId = participants.find((participant) => participant.isLocal)?.userId ?? localParticipantId;

    return messages.map((message) => ({
      id: message.id,
      senderId: message.senderId,
      senderName: message.senderName,
      content: message.content,
      timestamp: message.timestamp,
      isLocal: message.senderId === localParticipantId || (localChatSenderId !== undefined && message.senderId === localChatSenderId),
      attachments: message.attachments ?? [],
      readBy: message.readBy ?? [],
    }));
  }, [messages, localParticipantId, participants]);

  const meetingLayout = useMemo((): "grid" | "spotlight" | "sidebar" => {
    if (defaultsLayout) return defaultsLayout;
    if (layout === "speaker" || layout === "auto") return "spotlight";
    if (layout === "spotlight") return "spotlight";
    return "grid";
  }, [defaultsLayout, layout]);

  const selectedAudioOutput = media.selectedSpeaker ?? lobbySelectedSpeaker;
  const canManageParticipants = localRole === "host";

  return {
    allParticipants,
    localMeetingParticipant,
    chatMessages,
    meetingLayout,
    selectedAudioOutput,
    canManageParticipants,
  };
}
