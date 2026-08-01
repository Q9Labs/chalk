import type { ChalkAssignableParticipantRole, ChalkChatAttachment, ChalkReaction, ChalkWhiteboardSummary, ChalkWhiteboardV1Transport } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, type AlertButton, Linking, Share } from "react-native";

import { useChalkSession, useTelemetry } from "../../context/chalk-provider";
import { useChat } from "../../hooks/useChat";
import { useInteractions } from "../../hooks/useInteractions";
import { useLayout } from "../../hooks/useLayout";
import { useMedia } from "../../hooks/useMedia";
import { useMeetingParticipants } from "../../hooks/useMeetingParticipants";
import { useRoom } from "../../hooks/useRoom";
import { useScreenShare } from "../../hooks/useScreenShare";
import { useChalkSnapshot } from "../../hooks/useChalkSnapshot";
import { createNativeMediaRequestPrompt, createNativeRoomActionCommands } from "../../room-actions/native-room-actions";
import type { WhiteboardMetric } from "../../telemetry";
import { isIosSimulator } from "../../utils/ios-simulator";
import type { MeetingRoomProps } from "../MeetingRoom";
import { buildMeetingRoomDiagnosticsSnapshot } from "./diagnostics";
import { resolveNativeScreenShareAvailability } from "./screen-share-availability";
import type { MeetingPanelName } from "./types";
import { useMeetingRoomDerived } from "./useMeetingRoomDerived";

const emptyElements: readonly unknown[] = Object.freeze([]);
const emptyParticipants: readonly string[] = Object.freeze([]);

export interface MeetingWhiteboardController {
  readonly isOpen: boolean;
  readonly canDraw: boolean;
  readonly canClear: boolean;
  readonly elements: readonly unknown[];
  readonly openParticipants: readonly string[];
  readonly transport: ChalkWhiteboardV1Transport | null;
  readonly journeyId: string;
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly onMetric?: (metric: WhiteboardMetric) => void;
  readonly open: () => void;
  readonly close: () => void;
  readonly toggle: () => void;
  readonly requestSync: () => void;
  readonly clear: () => void;
}

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
  const layout = useLayout();
  const [panel, setPanel] = useState<MeetingPanelName | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [chatAttachments, setChatAttachments] = useState<readonly ChalkChatAttachment[]>([]);
  const [chatAttachmentsLoading, setChatAttachmentsLoading] = useState(false);
  const [secondsElapsed, setSecondsElapsed] = useState(0);
  const [whiteboardOpen, setWhiteboardOpen] = useState(false);
  const promptedRequestId = useRef<string | null>(null);
  const fallbackJourneyId = useRef(globalThis.crypto?.randomUUID?.() ?? `native-whiteboard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const whiteboardSummary = useWhiteboardSummary(session);
  const commands = useMemo(() => createNativeRoomActionCommands(session), [session]);

  useEffect(() => {
    const startedAt = Date.now();
    const update = () => setSecondsElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)));
    update();
    const timer = globalThis.setInterval(update, 1_000);
    return () => globalThis.clearInterval(timer);
  }, []);

  const localParticipant = snapshot.participants.find((participant) => participant.participantSessionId === snapshot.subject?.participantSessionId);
  const capabilities = localParticipant?.capabilities ?? [];
  const isHost = localParticipant?.role === "host";
  const canChat = features?.chat !== false && chat.isEnabled;
  const canParticipants = features?.participants !== false;
  const canReactions = features?.reactions !== false && interactions.reactionEnabled;
  const canHandRaise = features?.handRaise !== false;
  const screenShareAvailability = useMemo(
    () =>
      resolveNativeScreenShareAvailability({
        featureEnabled: features?.screenShare !== false,
      }),
    [features?.screenShare],
  );
  const canScreenShare = screenShareAvailability.enabled;
  const canWhiteboard = features?.whiteboard !== false && session.whiteboard !== null;
  const canManageAdmission = capabilities.includes("manageAdmission");
  const canSetParticipantRole = capabilities.includes("promoteDemote");
  const canTransferHost = capabilities.includes("transferHost");
  const canRequestMedia = capabilities.includes("requestMediaOthers");
  const canMuteParticipants = capabilities.includes("muteOthers");
  const canRemoveParticipants = capabilities.includes("removeParticipant");
  const canStopParticipantCamera = capabilities.includes("stopVideoOthers");
  const canStopParticipantScreenShare = capabilities.includes("stopScreenOthers");
  const canModerate = canManageAdmission || canSetParticipantRole || canTransferHost || canRequestMedia || canMuteParticipants || canRemoveParticipants || canStopParticipantCamera || canStopParticipantScreenShare;

  const run = useCallback(async (action: () => unknown | Promise<unknown>) => {
    try {
      await action();
    } catch (cause) {
      Alert.alert("Action failed", cause instanceof Error ? cause.message : "Chalk could not complete the action.");
    }
  }, []);

  const whiteboard = useMemo<MeetingWhiteboardController>(
    () => ({
      isOpen: canWhiteboard && whiteboardOpen,
      canDraw: canWhiteboard && whiteboardSummary.canDraw,
      canClear: canWhiteboard && whiteboardSummary.canClear,
      elements: emptyElements,
      openParticipants: emptyParticipants,
      transport: session.whiteboard,
      journeyId: telemetry?.session.context.journeyId ?? fallbackJourneyId.current,
      ...(telemetry?.session.context.traceparent ? { traceparent: telemetry.session.context.traceparent } : {}),
      ...(telemetry?.session.context.tracestate ? { tracestate: telemetry.session.context.tracestate } : {}),
      ...(telemetry ? { onMetric: telemetry.recordWhiteboardMetric } : {}),
      open: () => canWhiteboard && setWhiteboardOpen(true),
      close: () => setWhiteboardOpen(false),
      toggle: () => canWhiteboard && setWhiteboardOpen((value) => !value),
      requestSync: () => void run(() => session.whiteboard?.requestSnapshot()),
      clear: () => void run(() => session.whiteboard?.clear()),
    }),
    [canWhiteboard, run, session.whiteboard, telemetry, whiteboardOpen, whiteboardSummary.canClear, whiteboardSummary.canDraw],
  );
  const derived = useMeetingRoomDerived({
    participants: participants.participants,
    localParticipant: participants.localParticipant,
    screenShare,
    isWhiteboardOpen: whiteboard.isOpen,
  });

  useEffect(() => {
    const request = snapshot.incomingMediaRequests[0];
    if (!request || promptedRequestId.current === request.requestId) return;
    promptedRequestId.current = request.requestId;
    const prompt = createNativeMediaRequestPrompt(request, commands, (cause) => {
      Alert.alert("Request failed", cause instanceof Error ? cause.message : "The media request could not be applied.");
    });
    Alert.alert(prompt.title, prompt.message, [...prompt.buttons]);
  }, [commands, snapshot.incomingMediaRequests]);

  const roomDiagnostics = useMemo(
    () =>
      buildMeetingRoomDiagnosticsSnapshot({
        featureFlags: {
          chat: canChat,
          participants: canParticipants,
          screenShare: canScreenShare,
          reactions: canReactions,
          handRaise: canHandRaise,
          whiteboard: canWhiteboard,
        },
        isHost,
        participantCount: participants.participantCount,
        raisedHandCount: interactions.raisedHandCount,
        unreadChatCount: chat.unreadCount,
        isScreenShareActive: screenShare.isActive,
        isLocalScreenSharing: screenShare.isLocalSharing,
        screenShareSharerParticipantId: screenShare.sharerParticipantId,
        canModerate,
        screenShareAvailability,
      }),
    [canChat, canHandRaise, canModerate, canParticipants, canReactions, canScreenShare, canWhiteboard, chat.unreadCount, interactions.raisedHandCount, isHost, participants.participantCount, screenShare.isActive, screenShare.isLocalSharing, screenShare.sharerParticipantId, screenShareAvailability],
  );
  useEffect(() => onDiagnosticsChange?.(roomDiagnostics), [onDiagnosticsChange, roomDiagnostics]);

  const handleLeave = useCallback(() => {
    const buttons: AlertButton[] = [
      { text: "Cancel", style: "cancel" },
      { text: "Leave", style: "destructive", onPress: () => void run(onLeave) },
    ];
    if (isHost && onEndForAll) {
      buttons.splice(1, 0, {
        text: "End for All",
        style: "destructive",
        onPress: () => void run(onEndForAll),
      });
    }
    Alert.alert("Leave meeting?", "Choose how you want to leave.", buttons);
  }, [isHost, onEndForAll, onLeave, run]);

  const handleInviteParticipants = useCallback(() => {
    void run(async () => {
      if (!meetingLink) throw new Error("The meeting invite is not ready yet.");
      await Share.share({ message: meetingLink, title: roomName || room.roomId || "Chalk meeting", url: meetingLink });
    });
  }, [meetingLink, room.roomId, roomName, run]);

  return {
    simulatorMediaDisabled: isIosSimulator(),
    roomName: roomName || room.roomName || "Meeting",
    isHost,
    panel,
    selfName: participants.localParticipant?.displayName || "Guest",
    isMuted: !media.isAudioEnabled,
    isCameraOff: !media.isVideoEnabled,
    handRaised: interactions.isHandRaised,
    raisedHandCount: interactions.raisedHandCount,
    activeReactions: interactions.activeReactions.slice(-3),
    secondsElapsed,
    formattedDuration: `${Math.floor(secondsElapsed / 60)}:${String(secondsElapsed % 60).padStart(2, "0")}`,
    actionsOpen,
    reactionPickerOpen,
    chatDraft,
    chatAttachments,
    chatAttachmentsLoading,
    participantCount: participants.participantCount,
    canChat,
    canParticipants,
    canScreenShare,
    canReactions,
    canHandRaise,
    canWhiteboard,
    canManageAdmission,
    canSetParticipantRole,
    canTransferHost,
    canRequestMedia,
    canMuteParticipants,
    canRemoveParticipants,
    canStopParticipantCamera,
    canStopParticipantScreenShare,
    admissionRequests: snapshot.admissionRequests,
    roomDiagnostics,
    participants,
    chat,
    interactions,
    screenShare,
    layout,
    whiteboard,
    derived,
    setActionsOpen,
    setReactionPickerOpen,
    setChatDraft,
    handleLeave,
    openPanel: (nextPanel: MeetingPanelName) => {
      setActionsOpen(false);
      if (nextPanel === "whiteboard") whiteboard.open();
      else setPanel(nextPanel);
    },
    closePanel: () => setPanel(null),
    handleInviteParticipants,
    toggleAudio: () => void run(media.toggleAudio),
    toggleVideo: () => void run(media.toggleVideo),
    toggleScreenShare: () => void run(screenShare.toggle),
    toggleHand: () => void run(interactions.toggleHand),
    sendReaction: (reaction: ChalkReaction) => void run(() => interactions.sendReaction(reaction)),
    sendChatMessage: () => {
      const text = chatDraft.trim();
      if (!text && chatAttachments.length === 0) return;
      setChatDraft("");
      setChatAttachments([]);
      void run(() => chat.sendMessage({ text, attachments: chatAttachments }));
    },
    pickChatAttachments:
      pickChatAttachments && session.chatFiles
        ? () =>
            void run(async () => {
              setChatAttachmentsLoading(true);
              try {
                const attachments = await pickChatAttachments(session.chatFiles!);
                setChatAttachments((current) => [...current, ...attachments].slice(0, 5));
              } finally {
                setChatAttachmentsLoading(false);
              }
            })
        : undefined,
    removeChatAttachment: (attachmentId: string) => setChatAttachments((current) => current.filter((attachment) => attachment.attachmentId !== attachmentId)),
    openChatAttachment: (attachmentId: string) =>
      void run(async () => {
        if (!session.chatFiles) throw new Error("Chat attachment downloads are unavailable.");
        const { downloadUrl } = await session.chatFiles.getDownloadUrl(attachmentId);
        await Linking.openURL(downloadUrl);
      }),
    markChatMessageVisible: (sequence: string) => void run(() => chat.markAsRead(sequence)),
    admitParticipant: (admissionRequestId: string) => void run(() => session.admitParticipant(admissionRequestId)),
    denyAdmission: (admissionRequestId: string) => void run(() => session.denyAdmission(admissionRequestId)),
    setParticipantRole: (participantSessionId: string, role: ChalkAssignableParticipantRole) => void run(() => session.setParticipantRole(participantSessionId, role)),
    transferHost: (participantSessionId: string) => void run(() => session.transferHost(participantSessionId)),
    removeParticipant: (participantSessionId: string) => void run(() => session.removeParticipant(participantSessionId)),
    muteParticipant: (participantSessionId: string) => void run(() => session.muteParticipant(participantSessionId)),
    requestUnmuteParticipant: (participantSessionId: string) => void run(() => session.requestUnmute(participantSessionId)),
    requestStartParticipantCamera: (participantSessionId: string) => void run(() => session.requestStartCamera(participantSessionId)),
    stopParticipantCamera: (participantSessionId: string) => void run(() => session.stopParticipantCamera(participantSessionId)),
    stopParticipantScreenShare: (participantSessionId: string) => void run(() => session.stopParticipantScreenShare(participantSessionId)),
  };
}

function useWhiteboardSummary(session: ReturnType<typeof useChalkSession>): ChalkWhiteboardSummary {
  const subscribe = useCallback((listener: () => void) => session.subscribe(listener), [session]);
  const getSnapshot = useCallback(() => session.getSnapshot().whiteboard, [session]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
