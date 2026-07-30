import type { ChalkSessionStore, ChalkWhiteboardSummary, ChalkWhiteboardV1Transport } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, type AlertButton, Share } from "react-native";
import { useChalkSession, useSession } from "../../context/chalk-native-provider";
import { useChat } from "../../hooks/useChat";
import { useDevices } from "../../hooks/useDevices";
import { useInteractions } from "../../hooks/useInteractions";
import { useLayout } from "../../hooks/useLayout";
import { useMedia } from "../../hooks/useMedia";
import { usePanels } from "../../hooks/usePanels";
import { useParticipants } from "../../hooks/useParticipants";
import { useRecording } from "../../hooks/useRecording";
import { useRoom } from "../../hooks/useRoom";
import { useScreenShare } from "../../hooks/useScreenShare";
import { useTranscripts } from "../../hooks/useTranscripts";
import { useOptionalChalkSnapshot } from "../../hooks/useChalkRoomActions";
import { createNativeMediaRequestPrompt, createNativeRoomActionCommands, projectNativeRoomActions } from "../../room-actions/native-room-actions";
import { buildChalkInviteLink } from "../../utils/build-chalk-invite-link";
import { isIosSimulator } from "../../utils/ios-simulator";
import type { NativeMeetingRoomProps } from "../NativeMeetingRoom";
import { buildNativeMeetingRoomDiagnosticsSnapshot, type NativeMeetingRoomDiagnosticsSnapshot } from "./diagnostics";
import { NativeMeetingRoomControllerStore } from "./native-meeting-room-controller-store";
import { resolveNativeScreenShareAvailability } from "./screen-share-availability";
import type { NativeMeetingPanelName } from "./types";
import { useNativeMeetingRoomDerived } from "./useNativeMeetingRoomDerived";

const isDevRuntime = () => typeof __DEV__ !== "undefined" && __DEV__ === true;
const emptyWhiteboardElements: readonly unknown[] = Object.freeze([]);
const emptyWhiteboardParticipants: readonly string[] = Object.freeze([]);
const unavailableWhiteboardSummary: ChalkWhiteboardSummary = Object.freeze({
  status: "unsubscribed",
  sceneId: null,
  revision: null,
  capabilities: Object.freeze([]),
  canDraw: false,
  canClear: false,
  error: null,
});

export interface NativeMeetingWhiteboardController {
  readonly isOpen: boolean;
  readonly canDraw: boolean;
  readonly canClear: boolean;
  readonly elements: readonly unknown[];
  readonly openParticipants: readonly string[];
  readonly transport: ChalkWhiteboardV1Transport | null;
  readonly journeyId: string;
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly open: () => void;
  readonly close: () => void;
  readonly toggle: () => void;
  readonly requestSync: () => void;
  readonly clear: () => void;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function useCanonicalWhiteboardSummary(sessionStore: ChalkSessionStore | null): ChalkWhiteboardSummary {
  const subscribe = useCallback((listener: () => void) => sessionStore?.subscribe(listener) ?? (() => undefined), [sessionStore]);
  const getSnapshot = useCallback(() => sessionStore?.getSnapshot().whiteboard ?? unavailableWhiteboardSummary, [sessionStore]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function createJourneyId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `native-whiteboard-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface NativeMeetingRoomController {
  simulatorMediaDisabled: boolean;
  roomName: string;
  isHost: boolean;
  panel: NativeMeetingPanelName | null;
  selfName: string;
  isMuted: boolean;
  isCameraOff: boolean;
  handRaised: boolean;
  raisedHandCount: number;
  activeReactions: readonly { id: string; emoji: string; participantName: string }[];
  secondsElapsed: number;
  formattedDuration: string;
  actionsOpen: boolean;
  reactionPickerOpen: boolean;
  chatDraft: string;
  participantCount: number;
  canChat: boolean;
  canParticipants: boolean;
  canTranscripts: boolean;
  canSettings: boolean;
  canScreenShare: boolean;
  canRecording: boolean;
  canReactions: boolean;
  canHandRaise: boolean;
  canWhiteboard: boolean;
  canRequestMedia: boolean;
  canMuteParticipants: boolean;
  canRemoveParticipants: boolean;
  canStopParticipantCamera: boolean;
  roomDiagnostics: NativeMeetingRoomDiagnosticsSnapshot;
  devices: ReturnType<typeof useDevices>;
  participants: ReturnType<typeof useParticipants>;
  chat: ReturnType<typeof useChat>;
  transcripts: ReturnType<typeof useTranscripts>;
  interactions: ReturnType<typeof useInteractions>;
  recording: ReturnType<typeof useRecording>;
  screenShare: ReturnType<typeof useScreenShare>;
  layout: ReturnType<typeof useLayout>;
  panels: ReturnType<typeof usePanels>;
  whiteboard: NativeMeetingWhiteboardController;
  derived: ReturnType<typeof useNativeMeetingRoomDerived>;
  setActionsOpen: (open: boolean) => void;
  setReactionPickerOpen: (open: boolean) => void;
  setChatDraft: (value: string) => void;
  handleLeave: () => void;
  openPanel: (panel: NativeMeetingPanelName) => void;
  closePanel: () => void;
  handleInviteParticipants: () => void;
  toggleAudio: () => void;
  toggleVideo: () => void;
  toggleScreenShare: () => void;
  toggleHand: () => void;
  sendReaction: (emoji: string) => void;
  sendChatMessage: () => void;
  markChatMessageVisible: (sequence: string) => void;
  refreshDevices: () => void;
  removeParticipant: (participantId: string) => void;
  muteParticipant: (participantId: string) => void;
  requestUnmuteParticipant: (participantId: string) => void;
  requestStartParticipantCamera: (participantId: string) => void;
  stopParticipantCamera: (participantId: string) => void;
  selectCamera: (deviceId: string) => void;
  selectMicrophone: (deviceId: string) => void;
  selectSpeaker: (deviceId: string) => void;
}

export function useNativeMeetingRoomController({ roomName, features, onLeave, onEndForAll, onDiagnosticsChange }: NativeMeetingRoomProps): NativeMeetingRoomController {
  const simulatorMediaDisabled = isIosSimulator();
  const session = useSession();
  const { sessionStore, telemetry } = useChalkSession();
  const media = useMedia();
  const devices = useDevices();
  const participants = useParticipants();
  const room = useRoom();
  const chat = useChat();
  const transcripts = useTranscripts();
  const interactions = useInteractions();
  const recording = useRecording();
  const screenShare = useScreenShare();
  const layout = useLayout();
  const panels = usePanels();
  const chalkSnapshot = useOptionalChalkSnapshot();
  const whiteboardSummary = useCanonicalWhiteboardSummary(sessionStore);
  const [whiteboardOpen, setWhiteboardOpen] = useState(false);
  const fallbackJourneyId = useRef(createJourneyId());
  const roomActions = useMemo(() => projectNativeRoomActions(chalkSnapshot), [chalkSnapshot]);
  const roomActionCommands = useMemo(() => (sessionStore ? createNativeRoomActionCommands(sessionStore) : null), [sessionStore]);
  const promptedRequestId = useRef<string | null>(null);
  const store = useMemo(() => new NativeMeetingRoomControllerStore(), []);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const localChalkParticipant = chalkSnapshot?.participants.find((participant) => participant.participantSessionId === chalkSnapshot.subject?.participantSessionId);
  const isHost = (localChalkParticipant?.role ?? participants.localParticipant?.role ?? "participant") === "host";
  const panel = snapshot.localPanel ?? panels.activePanel;
  const selfName = participants.localParticipant?.displayName || "Guest";
  const isMuted = !media.isAudioEnabled;
  const isCameraOff = !media.isVideoEnabled;
  const handRaised = interactions.isHandRaised;
  const raisedHandCount = interactions.raisedHandCount;
  const activeReactions = interactions.activeReactions.slice(-3);
  const canChat = features?.chat !== false && roomActions.chatEnabled;
  const canParticipants = features?.participants !== false;
  const canTranscripts = features?.transcripts !== false;
  const canSettings = features?.settings !== false;
  const screenShareAvailability = useMemo(
    () =>
      resolveNativeScreenShareAvailability({
        featureEnabled: features?.screenShare !== false,
      }),
    [features?.screenShare],
  );
  const canScreenShare = screenShareAvailability.enabled;
  const canRecording = features?.recording !== false;
  const canReactions = features?.reactions !== false && roomActions.reactionEnabled;
  const canHandRaise = features?.handRaise !== false && sessionStore !== null;
  const whiteboardTransport = sessionStore?.whiteboard ?? null;
  const canWhiteboard = features?.whiteboard !== false && whiteboardTransport !== null;
  const canRequestMedia = localChalkParticipant?.capabilities.includes("requestMediaOthers") ?? false;
  const canMuteParticipants = localChalkParticipant?.capabilities.includes("muteOthers") ?? false;
  const canRemoveParticipants = localChalkParticipant?.capabilities.includes("removeParticipant") ?? false;
  const canStopParticipantCamera = localChalkParticipant?.capabilities.includes("stopVideoOthers") ?? false;

  const runAsync = useCallback(async (action: () => void | Promise<unknown>) => {
    try {
      await Promise.resolve(action());
    } catch (cause) {
      console.warn("NativeMeetingRoom async action failed:", cause);
    }
  }, []);

  const openWhiteboard = useCallback(() => {
    if (canWhiteboard) setWhiteboardOpen(true);
  }, [canWhiteboard]);
  const closeWhiteboard = useCallback(() => {
    setWhiteboardOpen(false);
  }, []);
  const toggleWhiteboard = useCallback(() => {
    if (!canWhiteboard) {
      setWhiteboardOpen(false);
      return;
    }
    setWhiteboardOpen((isOpen) => !isOpen);
  }, [canWhiteboard]);
  const requestWhiteboardSync = useCallback(() => {
    if (whiteboardTransport) void runAsync(() => whiteboardTransport.requestSnapshot());
  }, [runAsync, whiteboardTransport]);
  const clearWhiteboard = useCallback(() => {
    if (whiteboardTransport && whiteboardSummary.canClear) void runAsync(() => whiteboardTransport.clear());
  }, [runAsync, whiteboardSummary.canClear, whiteboardTransport]);
  const whiteboard = useMemo<NativeMeetingWhiteboardController>(
    () => ({
      isOpen: canWhiteboard && whiteboardOpen,
      canDraw: canWhiteboard && whiteboardSummary.canDraw,
      canClear: canWhiteboard && whiteboardSummary.canClear,
      elements: emptyWhiteboardElements,
      openParticipants: emptyWhiteboardParticipants,
      transport: whiteboardTransport,
      journeyId: telemetry?.session.context.journeyId ?? fallbackJourneyId.current,
      ...(telemetry?.session.context.traceparent ? { traceparent: telemetry.session.context.traceparent } : {}),
      ...(telemetry?.session.context.tracestate ? { tracestate: telemetry.session.context.tracestate } : {}),
      open: openWhiteboard,
      close: closeWhiteboard,
      toggle: toggleWhiteboard,
      requestSync: requestWhiteboardSync,
      clear: clearWhiteboard,
    }),
    [canWhiteboard, clearWhiteboard, closeWhiteboard, openWhiteboard, requestWhiteboardSync, telemetry, toggleWhiteboard, whiteboardOpen, whiteboardSummary.canClear, whiteboardSummary.canDraw, whiteboardTransport],
  );
  const derived = useNativeMeetingRoomDerived({
    participants: participants.participants,
    localParticipant: participants.localParticipant,
    screenShare,
    isWhiteboardOpen: whiteboard.isOpen,
  });

  useEffect(() => {
    if (!canWhiteboard) setWhiteboardOpen(false);
  }, [canWhiteboard]);

  useEffect(() => {
    const request = roomActions.incomingRequest;
    if (!request || !roomActionCommands) {
      promptedRequestId.current = null;
      return;
    }
    if (promptedRequestId.current === request.requestId) return;
    promptedRequestId.current = request.requestId;
    const prompt = createNativeMediaRequestPrompt(request, roomActionCommands, (cause) => {
      console.warn("NativeMeetingRoom media request failed:", cause);
    });
    Alert.alert(prompt.title, prompt.message, [...prompt.buttons]);
  }, [roomActionCommands, roomActions.incomingRequest]);

  const roomDiagnostics = useMemo(
    () =>
      buildNativeMeetingRoomDiagnosticsSnapshot({
        featureFlags: {
          chat: canChat,
          participants: canParticipants,
          transcripts: canTranscripts,
          settings: canSettings,
          screenShare: canScreenShare,
          recording: canRecording,
          reactions: canReactions,
          handRaise: canHandRaise,
          whiteboard: canWhiteboard,
        },
        isHost,
        participantCount: participants.participantCount,
        raisedHandCount,
        unreadChatCount: chat.unreadCount,
        isScreenShareActive: screenShare.isActive,
        isLocalScreenSharing: screenShare.isLocalSharing,
        screenShareSharerParticipantId: screenShare.sharerParticipantId,
        screenShareAvailability,
      }),
    [canChat, canHandRaise, canParticipants, canRecording, canReactions, canSettings, canTranscripts, canWhiteboard, chat.unreadCount, isHost, participants.participantCount, raisedHandCount, screenShare.isActive, screenShare.isLocalSharing, screenShare.sharerParticipantId, screenShareAvailability],
  );

  store.sync({
    diagnostics: roomDiagnostics,
    onDiagnosticsChange,
  });

  const handleLeave = useCallback(() => {
    const buttons: AlertButton[] = [
      { text: "Cancel", style: "cancel" },
      { text: "Leave", style: "destructive", onPress: () => void runAsync(async () => onLeave()) },
    ];

    if (isHost && onEndForAll) {
      buttons.splice(1, 0, {
        text: "End for All",
        style: "destructive",
        onPress: () => void runAsync(async () => onEndForAll()),
      });
    }

    Alert.alert("Leave meeting?", "Are you sure you want to leave this meeting?", buttons);
  }, [isHost, onEndForAll, onLeave, runAsync]);

  const openPanel = useCallback(
    (nextPanel: NativeMeetingPanelName) => {
      store.setActionsOpen(false);
      if (nextPanel === "whiteboard") {
        store.setLocalPanel(null);
        panels.closePanel();
        whiteboard.open();
        return;
      }
      if (nextPanel === "chat" && !canChat) return;
      if (nextPanel === "transcripts") {
        panels.closePanel();
        store.setLocalPanel("transcripts");
        return;
      }

      store.setLocalPanel(null);
      panels.openPanel(nextPanel);
    },
    [canChat, panels, store, whiteboard],
  );

  const closePanel = useCallback(() => {
    store.setLocalPanel(null);
    panels.closePanel();
  }, [panels, store]);

  const handleInviteParticipants = useCallback(() => {
    void runAsync(async () => {
      if (!room.roomId) {
        throw new Error("Room not ready for invite");
      }

      const invite = await session.createJoinToken(room.roomId);
      const inviteLink = buildChalkInviteLink(invite.joinToken);
      await Share.share({
        message: inviteLink,
        title: room.roomName || room.roomId,
        url: inviteLink,
      });
    });
  }, [room.roomId, room.roomName, runAsync, session]);

  return {
    simulatorMediaDisabled,
    roomName: roomName || room.roomName || "Meeting",
    isHost,
    panel,
    selfName,
    isMuted,
    isCameraOff,
    handRaised,
    raisedHandCount,
    activeReactions,
    secondsElapsed: snapshot.secondsElapsed,
    formattedDuration: formatDuration(snapshot.secondsElapsed),
    actionsOpen: snapshot.actionsOpen,
    reactionPickerOpen: snapshot.reactionPickerOpen,
    chatDraft: snapshot.chatDraft,
    participantCount: participants.participantCount,
    canChat,
    canParticipants,
    canTranscripts,
    canSettings,
    canScreenShare,
    canRecording,
    canReactions,
    canHandRaise,
    canWhiteboard,
    canRequestMedia,
    canMuteParticipants,
    canRemoveParticipants,
    canStopParticipantCamera,
    roomDiagnostics,
    devices,
    participants,
    chat,
    transcripts,
    interactions,
    recording,
    screenShare,
    layout,
    panels,
    whiteboard,
    derived,
    setActionsOpen: store.setActionsOpen,
    setReactionPickerOpen: store.setReactionPickerOpen,
    setChatDraft: store.setChatDraft,
    handleLeave,
    openPanel,
    closePanel,
    handleInviteParticipants,
    toggleAudio: () => {
      if (simulatorMediaDisabled) {
        return;
      }
      void runAsync(media.toggleAudio);
    },
    toggleVideo: () => {
      if (simulatorMediaDisabled) {
        return;
      }
      void runAsync(media.toggleVideo);
    },
    toggleScreenShare: () => {
      if (!screenShareAvailability.enabled) {
        return;
      }
      void runAsync(async () => {
        if (isDevRuntime()) {
          console.info("[chalk][native-meeting-room] screenshare:toggle:request", {
            availability: screenShareAvailability,
            stateBefore: {
              isActive: screenShare.isActive,
              isStarting: screenShare.isStarting,
              isLocalSharing: screenShare.isLocalSharing,
              sharerParticipantId: screenShare.sharerParticipantId,
            },
          });
        }

        const result = await screenShare.toggle();

        if (isDevRuntime()) {
          console.info("[chalk][native-meeting-room] screenshare:toggle:result", {
            result,
            stateAfter: {
              isActive: screenShare.isActive,
              isStarting: screenShare.isStarting,
              isLocalSharing: screenShare.isLocalSharing,
              sharerParticipantId: screenShare.sharerParticipantId,
            },
          });
        }
      });
    },
    toggleHand: () => {
      if (!canHandRaise) {
        return;
      }
      void runAsync(() => interactions.toggleHand());
    },
    sendReaction: (emoji: string) => {
      if (!canReactions) {
        return;
      }
      void runAsync(() => interactions.sendReaction(emoji));
    },
    sendChatMessage: () => {
      if (!snapshot.chatDraft.trim()) {
        return;
      }
      void runAsync(() => chat.sendMessage(snapshot.chatDraft.trim()));
      store.setChatDraft("");
    },
    markChatMessageVisible: (sequence: string) => {
      void runAsync(() => chat.markAsRead(sequence));
    },
    refreshDevices: () => {
      void runAsync(devices.refreshDevices);
    },
    removeParticipant: (participantId: string) => {
      if (!roomActionCommands) throw new Error("ChalkNativeProvider requires sessionStore for participant moderation.");
      void runAsync(() => roomActionCommands.removeParticipant(participantId));
    },
    muteParticipant: (participantId: string) => {
      if (!roomActionCommands) throw new Error("ChalkNativeProvider requires sessionStore for participant moderation.");
      void runAsync(() => roomActionCommands.muteParticipant(participantId));
    },
    requestUnmuteParticipant: (participantId: string) => {
      if (!roomActionCommands) throw new Error("ChalkNativeProvider requires sessionStore for media requests.");
      void runAsync(() => roomActionCommands.requestUnmute(participantId));
    },
    requestStartParticipantCamera: (participantId: string) => {
      if (!roomActionCommands) throw new Error("ChalkNativeProvider requires sessionStore for media requests.");
      void runAsync(() => roomActionCommands.requestStartCamera(participantId));
    },
    stopParticipantCamera: (participantId: string) => {
      if (!roomActionCommands) throw new Error("ChalkNativeProvider requires sessionStore for participant moderation.");
      void runAsync(() => roomActionCommands.stopParticipantCamera(participantId));
    },
    selectCamera: (deviceId: string) => {
      void runAsync(() => devices.selectCamera(deviceId));
    },
    selectMicrophone: (deviceId: string) => {
      void runAsync(() => devices.selectMicrophone(deviceId));
    },
    selectSpeaker: (deviceId: string) => {
      void runAsync(() => devices.selectSpeaker(deviceId));
    },
  };
}
