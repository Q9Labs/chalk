import type { ChatSendInput, Reaction } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Linking } from "react-native";

import { useSpaceClient } from "../../context/space-client-context";
import { useChat as useSpaceChat, useMedia as useSpaceMedia, useParticipants as useSpaceParticipants, useReactions as useSpaceReactions, useSelf, useWhiteboard } from "../../hooks/space-hooks";
import { getNativeJourneyContext } from "../../telemetry";
import type { NativeChatMessage, NativeParticipant, NativeReaction } from "../../ui/native-types";
import { isIosSimulator } from "../../utils/ios-simulator";
import type { SpaceViewProps } from "../SpaceView";
import { buildSpaceViewDiagnosticsSnapshot } from "./diagnostics";
import { useSpaceViewDerived } from "./useSpaceViewDerived";
import { useSpaceViewPanels } from "./useSpaceViewPanels";
import { resolveNativeScreenShareAvailability } from "./screen-share-availability";
import { normalizeChatFileDrafts, uploadAndSendNativeChatAttachments, type NativeChatFileDraft } from "./space-chat-attachments";

const spaceReactions = new Set<Reaction>(["👍", "❤️", "😂", "😮", "😢", "🎉"]);

/**
 * The native Space UI consumes the canonical SpaceClient snapshot directly.
 * This keeps the mature native renderer intact without re-projecting client
 * state through a retired compatibility layer.
 */
export function useSpaceViewController({ spaceName, inviteLink, layout: controlledLayout, onLayoutChange, features, onLeave, onEndEpisode, onDiagnosticsChange, pickChatFiles: pickChatFilesInput }: SpaceViewProps) {
  const client = useSpaceClient();
  const self = useSelf();
  const participantSlice = useSpaceParticipants();
  const media = useSpaceMedia();
  const chatSlice = useSpaceChat();
  const reactionSlice = useSpaceReactions();
  const whiteboardSlice = useWhiteboard();
  const journeyContext = getNativeJourneyContext(client);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [chatAttachments, setChatAttachments] = useState<readonly NativeChatFileDraft[]>([]);
  const [chatAttachmentError, setChatAttachmentError] = useState<string | null>(null);
  const [chatAttachmentPicking, setChatAttachmentPicking] = useState(false);
  const [chatAttachmentUploading, setChatAttachmentUploading] = useState(false);

  const run = useCallback(async (action: () => unknown | Promise<unknown>) => {
    try {
      await action();
    } catch (cause) {
      Alert.alert("Action failed", cause instanceof Error ? cause.message : "Chalk could not complete the action.");
    }
  }, []);

  const localParticipantId = self.participantId;
  const participants = useMemo(
    () =>
      participantSlice.roster.map((participant): NativeParticipant => {
        const local = participant.participantId === localParticipantId;
        const remoteMedia = media.remote.filter((publication) => publication.participantId === participant.participantId);
        return {
          ...participant,
          id: participant.participantId,
          audioEnabled: local ? media.local.microphone.state === "enabled" || media.local.microphone.state === "requesting" : participant.media.microphone === "active",
          videoEnabled: local ? media.local.camera.state === "enabled" || media.local.camera.state === "requesting" : participant.media.camera === "active",
          audioTrack: local ? media.local.microphone.track : (remoteMedia.find((publication) => publication.source === "microphone")?.track ?? null),
          videoTrack: local ? media.local.camera.track : (remoteMedia.find((publication) => publication.source === "camera")?.track ?? null),
          screenShareTrack: local ? media.screenShare.track : (remoteMedia.find((publication) => publication.source === "screen")?.track ?? null),
        };
      }),
    [localParticipantId, media.local.camera, media.local.microphone, media.remote, media.screenShare.track, participantSlice.roster],
  );
  const localParticipant = useMemo(() => participants.find((participant) => participant.id === localParticipantId) ?? null, [localParticipantId, participants]);
  const spaceParticipants = useMemo(
    () => ({
      participants,
      localParticipant,
      remoteParticipants: participants.filter((participant) => participant.id !== localParticipantId),
      activeSpeaker: null,
      count: participants.length,
      participantCount: participants.length,
      getParticipant: (participantId: string) => participants.find((participant) => participant.id === participantId),
      updateDisplayName: (displayName: string) => client.participants.renameSelf(displayName),
    }),
    [client.participants, localParticipant, localParticipantId, participants],
  );

  const isLocalSharing = media.screenShare.state === "enabled" || media.screenShare.state === "requesting";
  const remoteScreenShare = useMemo(() => media.remote.find((publication) => publication.source === "screen") ?? null, [media.remote]);
  const screenShare = useMemo(
    () => ({
      isActive: isLocalSharing || remoteScreenShare !== null,
      isStarting: media.screenShare.state === "requesting",
      isLocalSharing,
      sharerParticipantId: isLocalSharing ? localParticipantId : (remoteScreenShare?.participantId ?? null),
      videoTrack: isLocalSharing ? media.screenShare.track : (remoteScreenShare?.track ?? null),
      audioTrack: null,
      start: async () => {
        await client.media.setScreenShareEnabled(true);
        return true;
      },
      stop: () => client.media.setScreenShareEnabled(false),
      toggle: async () => {
        const enabled = !isLocalSharing;
        await client.media.setScreenShareEnabled(enabled);
        return enabled;
      },
    }),
    [client.media, isLocalSharing, localParticipantId, media.screenShare.state, media.screenShare.track, remoteScreenShare],
  );

  const interactionState = useMemo(() => {
    const raisedHands = participantSlice.roster.filter((participant) => participant.handRaised).map((participant) => participant.participantId);
    const activeReactions: NativeReaction[] = reactionSlice.active.map((reaction) => ({
      id: reaction.eventId,
      emoji: reaction.reaction,
      participantId: reaction.participantId,
      participantName: reaction.displayName,
    }));
    return {
      isHandRaised: self.handRaised,
      raisedHands,
      raisedHandCount: raisedHands.length,
      activeReactions,
      reactionEnabled: self.can("sendReaction"),
      raiseHand: () => client.participants.raiseHand(),
      lowerHand: () => client.participants.lowerHand(),
      toggleHand: () => (self.handRaised ? client.participants.lowerHand() : client.participants.raiseHand()),
      sendReaction: (reaction: Reaction) => client.reactions.send(reaction),
    };
  }, [client.participants, client.reactions, participantSlice.roster, reactionSlice.active, self]);

  const chat = useMemo(() => {
    const messages: NativeChatMessage[] = chatSlice.messages.map((message) => ({
      id: message.messageId,
      sequence: message.sequence,
      senderId: message.participantId,
      senderName: message.displayName,
      text: message.text,
      content: message.text,
      attachments: message.attachments,
      readBy: chatSlice.readReceipts
        .filter((receipt) => receipt.participantId !== message.participantId && receipt.participantId !== localParticipantId && sequenceAtOrAfter(receipt.readThroughSequence, message.sequence))
        .map((receipt) => ({
          ...receipt,
          displayName: participantSlice.roster.find((participant) => participant.participantId === receipt.participantId)?.displayName ?? "Participant",
        })),
      timestamp: Date.parse(message.createdAt),
    }));
    const pendingMessages = chatSlice.pendingSends.map((pending) => ({ ...pending, state: pending.status }));
    const sendMessage = (content: string | ChatSendInput) => client.chat.send(typeof content === "string" ? { text: content } : content).then(() => undefined);
    const markAsRead = (throughSequence?: string) => {
      const target = throughSequence ? chatSlice.messages.find((message) => message.sequence === throughSequence) : chatSlice.messages.at(-1);
      return target ? client.chat.markRead(target.messageId) : Promise.resolve(null);
    };
    return {
      messages,
      isEnabled: self.can("sendChat"),
      count: messages.length,
      unreadCount: chatSlice.unreadCount,
      pendingMessages,
      hasMore: chatSlice.pagination.hasOlder,
      isLoadingOlder: chatSlice.status === "loading",
      sendMessage,
      retryMessage: (clientMessageId: string) => {
        const pending = chatSlice.pendingSends.find((message) => message.clientMessageId === clientMessageId);
        return pending ? client.chat.send({ text: pending.text, attachments: pending.attachments }).then(() => undefined) : Promise.reject(new Error("The pending message is no longer available."));
      },
      loadOlderMessages: () => client.chat.loadOlder().then(() => undefined),
      reactToMessage: () => {
        throw new Error("Per-message reactions are not part of the actions contract.");
      },
      markAsRead,
      markAsHidden: markAsRead,
      getMessage: (id: string) => messages.find((message) => message.id === id),
    };
  }, [chatSlice, client.chat, localParticipantId, participantSlice.roster, self]);

  const canWhiteboard = features?.whiteboard !== false && whiteboardSlice.engine.status !== "unsubscribed";
  const canDraw = canWhiteboard && self.can("drawWhiteboard");
  const canClear = canWhiteboard && self.can("manageWhiteboard");
  const whiteboardTransport = useMemo(() => client.whiteboard.transport(), [client.whiteboard, whiteboardSlice.engine.status]);
  const canEndEpisode = self.can("endEpisode");
  const screenShareAvailability = useMemo(() => resolveNativeScreenShareAvailability({ featureEnabled: features?.screenShare !== false }), [features?.screenShare]);
  const capabilities = useMemo(
    () => ({
      canEndEpisode,
      canChat: features?.chat !== false && self.can("sendChat"),
      canParticipants: features?.participants !== false,
      canScreenShare: screenShareAvailability.enabled && self.can("publishScreen"),
      canReactions: features?.reactions !== false && self.can("sendReaction"),
      canHandRaise: features?.handRaise !== false && self.can("raiseHand"),
      canInvite: features?.info !== false && Boolean(inviteLink),
      canSettings: features?.settings !== false,
      canWhiteboard,
      canManageAdmission: features?.admission !== false && self.can("manageAdmission"),
      canRequestMedia: self.can("requestMediaOthers"),
      canMuteParticipants: self.can("muteOthers"),
      canRemoveParticipants: self.can("removeParticipant"),
      canStopParticipantCamera: self.can("stopVideoOthers"),
      canStopParticipantScreenShare: self.can("stopScreenOthers"),
      canModerate: self.can("manageAdmission") || self.can("assignRoles") || self.can("requestMediaOthers") || self.can("muteOthers") || self.can("removeParticipant") || self.can("stopVideoOthers") || self.can("stopScreenOthers"),
      screenShareAvailability,
    }),
    [canEndEpisode, canWhiteboard, features?.admission, features?.chat, features?.handRaise, features?.info, features?.participants, features?.reactions, features?.settings, inviteLink, screenShareAvailability, self],
  );

  const spacePanels = useSpaceViewPanels({
    spaceName,
    inviteLink,
    layout: controlledLayout,
    onLayoutChange,
    canWhiteboard,
    canDraw,
    canClear,
    canEndEpisode,
    transport: whiteboardTransport,
    onLeave,
    onEndEpisode,
    run,
    journeyContext,
  });
  const derived = useSpaceViewDerived({ participants, localParticipant, screenShare, isWhiteboardOpen: spacePanels.whiteboard.isOpen });

  useEffect(() => {
    const request = media.incomingRequests[0];
    if (!request) return;
    Alert.alert(request.kind === "unmute" ? "Unmute request" : "Camera request", `${request.actorDisplayName ?? "A Space organizer"} is asking you to ${request.kind === "unmute" ? "unmute" : "start your camera"}.`, [
      { text: "Not now", style: "cancel", onPress: () => void run(() => client.media.declineRequest(request.requestId)) },
      { text: "Allow", onPress: () => void run(() => client.media.acceptRequest(request.requestId)) },
    ]);
  }, [client.media, media.incomingRequests, run]);

  const spaceDiagnostics = useMemo(
    () =>
      buildSpaceViewDiagnosticsSnapshot({
        featureFlags: {
          chat: capabilities.canChat,
          participants: capabilities.canParticipants,
          screenShare: capabilities.canScreenShare,
          reactions: capabilities.canReactions,
          handRaise: capabilities.canHandRaise,
          whiteboard: capabilities.canWhiteboard,
        },
        canEndEpisode: capabilities.canEndEpisode,
        participantCount: spaceParticipants.participantCount,
        raisedHandCount: interactionState.raisedHandCount,
        unreadChatCount: chat.unreadCount,
        isScreenShareActive: screenShare.isActive,
        isLocalScreenSharing: screenShare.isLocalSharing,
        screenShareSharerParticipantId: screenShare.sharerParticipantId,
        canModerate: capabilities.canModerate,
        screenShareAvailability,
      }),
    [capabilities, chat.unreadCount, interactionState.raisedHandCount, spaceParticipants.participantCount, screenShare.isActive, screenShare.isLocalSharing, screenShare.sharerParticipantId, screenShareAvailability],
  );
  useEffect(() => onDiagnosticsChange?.(spaceDiagnostics), [onDiagnosticsChange, spaceDiagnostics]);

  const pickChatFiles = useCallback(async () => {
    if (!pickChatFilesInput) return;
    setChatAttachmentPicking(true);
    try {
      const picked = normalizeChatFileDrafts(await pickChatFilesInput());
      if (picked.error) {
        setChatAttachmentError(picked.error);
        return;
      }
      const combined = normalizeChatFileDrafts([...chatAttachments.map((draft) => draft.file), ...picked.files.map((draft) => draft.file)]);
      if (combined.error) {
        setChatAttachmentError(combined.error);
        return;
      }
      setChatAttachmentError(null);
      setChatAttachments(combined.files);
    } catch (cause) {
      setChatAttachmentError(cause instanceof Error ? cause.message : "Could not read the selected files.");
    } finally {
      setChatAttachmentPicking(false);
    }
  }, [chatAttachments, pickChatFilesInput]);

  const removeChatAttachment = useCallback((index: number) => {
    setChatAttachments((current) => current.filter((_, currentIndex) => currentIndex !== index));
    setChatAttachmentError(null);
  }, []);

  const sendChatMessage = useCallback(() => {
    const text = chatDraft.trim();
    if (!text && chatAttachments.length === 0) return;
    void run(async () => {
      setChatAttachmentUploading(true);
      setChatAttachmentError(null);
      try {
        await uploadAndSendNativeChatAttachments(chatAttachments, text, client.chat.files.upload, chat.sendMessage);
        setChatDraft("");
        setChatAttachments([]);
      } catch (cause) {
        setChatAttachmentError(cause instanceof Error ? cause.message : "Could not send the attachments.");
        throw cause;
      } finally {
        setChatAttachmentUploading(false);
      }
    });
  }, [chat, chatAttachments, chatDraft, client.chat.files, run]);

  return {
    simulatorMediaDisabled: isIosSimulator(),
    spaceName: spaceName || "Space",
    panel: spacePanels.panel,
    selfName: self.displayName || "Participant",
    isMuted: !(media.local.microphone.state === "enabled" || media.local.microphone.state === "requesting"),
    isCameraOff: !(media.local.camera.state === "enabled" || media.local.camera.state === "requesting"),
    handRaised: interactionState.isHandRaised,
    raisedHandCount: interactionState.raisedHandCount,
    activeReactions: interactionState.activeReactions.slice(-3),
    secondsElapsed: spacePanels.secondsElapsed,
    formattedDuration: spacePanels.formattedDuration,
    actionsOpen,
    reactionPickerOpen,
    chatDraft,
    chatAttachments,
    chatAttachmentError,
    chatAttachmentPicking,
    chatAttachmentUploading,
    canPickChatFiles: Boolean(pickChatFilesInput),
    participantCount: spaceParticipants.participantCount,
    canChat: capabilities.canChat,
    canParticipants: capabilities.canParticipants,
    canScreenShare: capabilities.canScreenShare,
    canReactions: capabilities.canReactions,
    canHandRaise: capabilities.canHandRaise,
    canInvite: capabilities.canInvite,
    canSettings: capabilities.canSettings,
    canWhiteboard: capabilities.canWhiteboard,
    canManageAdmission: capabilities.canManageAdmission,
    canRequestMedia: capabilities.canRequestMedia,
    canMuteParticipants: capabilities.canMuteParticipants,
    canRemoveParticipants: capabilities.canRemoveParticipants,
    canStopParticipantCamera: capabilities.canStopParticipantCamera,
    canStopParticipantScreenShare: capabilities.canStopParticipantScreenShare,
    admissionRequests: participantSlice.admissionQueue,
    spaceDiagnostics,
    participants: spaceParticipants,
    settings: {
      displayName: self.displayName ?? "",
      microphoneEnabled: media.local.microphone.state === "enabled" || media.local.microphone.state === "requesting",
      cameraEnabled: media.local.camera.state === "enabled" || media.local.camera.state === "requesting",
      devices: media.devices,
      selection: media.selection,
      updateDisplayName: (displayName: string) => {
        const nextDisplayName = displayName.trim();
        if (nextDisplayName) void run(() => client.participants.renameSelf(nextDisplayName));
      },
      selectMicrophone: (deviceId: string) => void run(() => client.media.selectMicrophone(deviceId)),
      selectCamera: (deviceId: string) => void run(() => client.media.selectCamera(deviceId)),
      selectSpeaker: (deviceId: string) => void run(() => client.media.selectSpeaker(deviceId)),
    },
    chat,
    interactions: interactionState,
    screenShare,
    layout: spacePanels.layout,
    whiteboard: spacePanels.whiteboard,
    derived,
    setActionsOpen,
    setReactionPickerOpen,
    setChatDraft,
    pickChatFiles,
    removeChatAttachment,
    handleLeave: spacePanels.handleLeave,
    openPanel: spacePanels.openPanel,
    closePanel: spacePanels.closePanel,
    handleInviteParticipants: spacePanels.handleInviteParticipants,
    toggleAudio: () => void run(() => client.media.setMicrophoneEnabled(!(media.local.microphone.state === "enabled" || media.local.microphone.state === "requesting"))),
    toggleVideo: () => void run(() => client.media.setCameraEnabled(!(media.local.camera.state === "enabled" || media.local.camera.state === "requesting"))),
    toggleScreenShare: () => void run(screenShare.toggle),
    toggleHand: () => void run(interactionState.toggleHand),
    sendReaction: (reaction: Reaction) => {
      if (!spaceReactions.has(reaction)) return;
      void run(() => interactionState.sendReaction(reaction));
    },
    sendChatMessage,
    openChatAttachment: (attachmentId: string) => {
      const attachment = chat.messages.flatMap((message) => message.attachments).find((candidate) => candidate.attachmentId === attachmentId);
      if (attachment) void run(() => Linking.openURL(client.chat.files.url(attachment)));
    },
    markChatMessageVisible: (sequence: string) => void run(() => chat.markAsRead(sequence)),
    admitParticipant: (requestId: string) => void run(() => client.participants.admit(requestId)),
    denyAdmission: (requestId: string) => void run(() => client.participants.deny(requestId)),
    removeParticipant: (participantId: string) => void run(() => client.participants.remove(participantId)),
    muteParticipant: (participantId: string) => void run(() => client.participants.mute(participantId)),
    requestUnmuteParticipant: (participantId: string) => void run(() => client.participants.requestMedia(participantId, "microphone")),
    requestStartParticipantCamera: (participantId: string) => void run(() => client.participants.requestMedia(participantId, "camera")),
    stopParticipantCamera: (participantId: string) => void run(() => client.participants.stopVideo(participantId)),
    stopParticipantScreenShare: (participantId: string) => void run(() => client.participants.stopScreenShare(participantId)),
  };
}

function sequenceAtOrAfter(value: string, floor: string): boolean {
  const normalizedValue = value.replace(/^0+(?=\d)/, "");
  const normalizedFloor = floor.replace(/^0+(?=\d)/, "");
  return normalizedValue.length > normalizedFloor.length || (normalizedValue.length === normalizedFloor.length && normalizedValue >= normalizedFloor);
}
