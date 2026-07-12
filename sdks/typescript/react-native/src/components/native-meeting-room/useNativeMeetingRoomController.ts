import { useCallback, useMemo, useSyncExternalStore } from "react";
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
import { useWhiteboard } from "../../hooks/useWhiteboard";
import { buildChalkInviteLink } from "../../utils/build-chalk-invite-link";
import { isIosSimulator } from "../../utils/ios-simulator";
import type { NativeMeetingRoomProps } from "../NativeMeetingRoom";
import { buildNativeMeetingRoomDiagnosticsSnapshot, type NativeMeetingRoomDiagnosticsSnapshot } from "./diagnostics";
import { NativeMeetingRoomControllerStore } from "./native-meeting-room-controller-store";
import { resolveNativeScreenShareAvailability } from "./screen-share-availability";
import type { NativeMeetingPanelName } from "./types";
import { useNativeMeetingRoomDerived } from "./useNativeMeetingRoomDerived";

const isDevRuntime = () => typeof __DEV__ !== "undefined" && __DEV__ === true;

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
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
  whiteboard: ReturnType<typeof useWhiteboard>;
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
  refreshDevices: () => void;
  removeParticipant: (participantId: string) => void;
  muteParticipant: (participantId: string) => void;
  unmuteParticipant: (participantId: string) => void;
  selectCamera: (deviceId: string) => void;
  selectMicrophone: (deviceId: string) => void;
  selectSpeaker: (deviceId: string) => void;
}

export function useNativeMeetingRoomController({ roomName, features, onLeave, onEndForAll, onDiagnosticsChange }: NativeMeetingRoomProps): NativeMeetingRoomController {
  const simulatorMediaDisabled = isIosSimulator();
  const session = useSession();
  const { removeParticipant, muteParticipant, unmuteParticipant } = useChalkSession();
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
  const whiteboard = useWhiteboard();
  const derived = useNativeMeetingRoomDerived({
    participants: participants.participants,
    localParticipant: participants.localParticipant,
    screenShare,
    isWhiteboardOpen: whiteboard.isOpen,
  });

  const store = useMemo(() => new NativeMeetingRoomControllerStore(), []);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const isHost = (participants.localParticipant?.role ?? "participant") === "host";
  const panel = snapshot.localPanel ?? panels.activePanel;
  const selfName = participants.localParticipant?.displayName || "Guest";
  const isMuted = !media.isAudioEnabled;
  const isCameraOff = !media.isVideoEnabled;
  const handRaised = interactions.isHandRaised;
  const raisedHandCount = interactions.raisedHandCount;
  const activeReactions = interactions.activeReactions.slice(-3);
  const canChat = features?.chat !== false;
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
  const canReactions = features?.reactions !== false;
  const canHandRaise = features?.handRaise !== false;
  const canWhiteboard = features?.whiteboard !== false;

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
    panel,
    markChatAsRead: chat.markAsRead,
    diagnostics: roomDiagnostics,
    onDiagnosticsChange,
  });

  const runAsync = useCallback(async (action: () => void | Promise<unknown>) => {
    try {
      await Promise.resolve(action());
    } catch (cause) {
      console.warn("NativeMeetingRoom async action failed:", cause);
    }
  }, []);

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
      if (nextPanel === "transcripts") {
        panels.closePanel();
        store.setLocalPanel("transcripts");
        return;
      }

      store.setLocalPanel(null);
      panels.openPanel(nextPanel);
    },
    [panels, store],
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
      interactions.toggleHand();
    },
    sendReaction: (emoji: string) => {
      if (!canReactions) {
        return;
      }
      interactions.sendReaction(emoji);
    },
    sendChatMessage: () => {
      if (!snapshot.chatDraft.trim()) {
        return;
      }
      chat.sendMessage(snapshot.chatDraft.trim());
      store.setChatDraft("");
    },
    refreshDevices: () => {
      void runAsync(devices.refreshDevices);
    },
    removeParticipant: (participantId: string) => {
      void runAsync(() => removeParticipant(participantId));
    },
    muteParticipant: (participantId: string) => {
      void runAsync(() => muteParticipant(participantId));
    },
    unmuteParticipant: (participantId: string) => {
      void runAsync(() => unmuteParticipant(participantId));
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
