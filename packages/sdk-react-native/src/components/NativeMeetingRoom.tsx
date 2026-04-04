import type { LayoutMode, ParticipantState, ReactionEmoji } from "@q9labs/chalk-core";
import CallEnd01Icon from "@hugeicons/core-free-icons/dist/esm/CallEnd01Icon";
import Chat01Icon from "@hugeicons/core-free-icons/dist/esm/Chat01Icon";
import Mic01Icon from "@hugeicons/core-free-icons/dist/esm/Mic01Icon";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import MoreHorizontalIcon from "@hugeicons/core-free-icons/dist/esm/MoreHorizontalIcon";
import UserGroupIcon from "@hugeicons/core-free-icons/dist/esm/UserGroupIcon";
import Video01Icon from "@hugeicons/core-free-icons/dist/esm/Video01Icon";
import VideoOffIcon from "@hugeicons/core-free-icons/dist/esm/VideoOffIcon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, type AlertButton, Platform, Pressable, Share, StyleSheet, Text, View } from "react-native";
import { useChalkSession, useSession } from "../context/chalk-native-provider";
import { useChat } from "../hooks/useChat";
import { useDevices } from "../hooks/useDevices";
import { useInteractions } from "../hooks/useInteractions";
import { useLayout } from "../hooks/useLayout";
import { useMedia } from "../hooks/useMedia";
import { usePanels } from "../hooks/usePanels";
import { useParticipants } from "../hooks/useParticipants";
import { useRecording } from "../hooks/useRecording";
import { useRoom } from "../hooks/useRoom";
import { useScreenShare } from "../hooks/useScreenShare";
import { useTranscripts } from "../hooks/useTranscripts";
import { useWhiteboard } from "../hooks/useWhiteboard";
import { Theme } from "../ui/theme";
import { buildChalkInviteLink } from "../utils/build-chalk-invite-link";
import { getIosSimulatorMediaMessage, isIosSimulator } from "../utils/ios-simulator";
import { NativeMeetingActionsSheet } from "./NativeMeetingActionsSheet";
import { NativeMeetingPanel, type NativeMeetingPanelName } from "./NativeMeetingPanel";
import { NativeReactionPicker } from "./NativeReactionPicker";
import { NativeMeetingGrid } from "./native-meeting-room/NativeMeetingGrid";
import { NativeMeetingStage } from "./native-meeting-room/NativeMeetingStage";
import { buildNativeMeetingRoomDiagnosticsSnapshot, type NativeMeetingRoomDiagnosticsSnapshot } from "./native-meeting-room/diagnostics";
import { useNativeMeetingRoomDerived } from "./native-meeting-room/useNativeMeetingRoomDerived";

type RoomParticipant = ParticipantState["participants"][number];

export interface NativeMeetingRoomFeatures {
  chat?: boolean;
  participants?: boolean;
  transcripts?: boolean;
  settings?: boolean;
  screenShare?: boolean;
  recording?: boolean;
  reactions?: boolean;
  handRaise?: boolean;
  whiteboard?: boolean;
}

export interface NativeMeetingRoomProps {
  roomName?: string;
  features?: NativeMeetingRoomFeatures;
  onLeave: () => void | Promise<void>;
  onEndForAll?: () => void | Promise<void>;
  onDiagnosticsChange?: (snapshot: NativeMeetingRoomDiagnosticsSnapshot) => void;
}

export type { NativeMeetingRoomDiagnosticsSnapshot };

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function NativeMeetingRoom({ features, onLeave, onEndForAll, onDiagnosticsChange }: NativeMeetingRoomProps): React.JSX.Element {
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
    participants: participants.participants as readonly RoomParticipant[],
    localParticipant: participants.localParticipant as RoomParticipant | null,
    screenShare,
    isWhiteboardOpen: whiteboard.isOpen,
  });

  const [actionsOpen, setActionsOpen] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [localPanel, setLocalPanel] = useState<NativeMeetingPanelName | null>(null);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [secondsElapsed, setSecondsElapsed] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsElapsed((s) => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const isHost = (participants.localParticipant?.role ?? "participant") === "host";
  const panel = localPanel ?? (panels.activePanel as NativeMeetingPanelName | null);
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
  const canScreenShare = features?.screenShare !== false;
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
      }),
    [canChat, canHandRaise, canParticipants, canRecording, canReactions, canScreenShare, canSettings, canTranscripts, canWhiteboard, chat.unreadCount, isHost, participants.participantCount, raisedHandCount, screenShare.isActive, screenShare.isLocalSharing, screenShare.sharerParticipantId],
  );
  const lastDiagnosticsSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (panel === "chat") {
      chat.markAsRead();
    }
  }, [panel, chat.markAsRead]);

  useEffect(() => {
    if (!onDiagnosticsChange) {
      return;
    }

    const nextSignature = JSON.stringify(roomDiagnostics);
    if (lastDiagnosticsSignatureRef.current === nextSignature) {
      return;
    }

    lastDiagnosticsSignatureRef.current = nextSignature;
    onDiagnosticsChange(roomDiagnostics);
  }, [onDiagnosticsChange, roomDiagnostics]);

  const runAsync = useCallback(async (action: () => Promise<unknown>) => {
    try {
      await action();
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
      setActionsOpen(false);
      if (nextPanel === "transcripts") {
        panels.closePanel();
        setLocalPanel("transcripts");
        return;
      }

      setLocalPanel(null);
      panels.openPanel(nextPanel);
    },
    [panels],
  );

  const closePanel = useCallback(() => {
    setLocalPanel(null);
    panels.closePanel();
  }, [panels]);

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

  return (
    <View style={styles.roomScreen}>
      <View style={styles.topBar}>
        <View style={styles.topBarLeft}>
          <View style={styles.connectionDot} />
          <Text style={styles.topBarRoomName} numberOfLines={1}>
            {room.roomName || "Meeting"}
          </Text>
          <View style={styles.timerBadge}>
            <Text style={styles.timerText}>{formatDuration(secondsElapsed)}</Text>
          </View>
        </View>
        <View style={styles.topBarRight}>
          <HugeiconsIcon icon={UserGroupIcon} size={14} color="#ffffff" />
          <Text style={styles.topBarCount}>{participants.participantCount}</Text>
        </View>
      </View>

      <View style={styles.stageFrame}>
        {derived.isStageMode ? (
          <NativeMeetingStage
            activeReactions={activeReactions}
            handRaised={handRaised}
            isCompactViewport={derived.isCompactViewport}
            isHost={isHost}
            isMuted={isMuted}
            isRecording={recording.isRecording}
            layoutMode={layout.layout}
            primaryContent={derived.primaryContent}
            raisedHandCount={raisedHandCount}
            screenShareTrack={derived.screenShareTrack}
            screenSharer={derived.screenSharer}
            selfName={selfName}
            stripParticipants={derived.allParticipants}
            whiteboard={{
              isOpen: whiteboard.isOpen,
              canDraw: whiteboard.canDraw,
              elementCount: whiteboard.elements.length,
              participantCount: whiteboard.openParticipants.length,
            }}
          />
        ) : (
          <NativeMeetingGrid gridPages={derived.gridPages} participants={derived.allParticipants} />
        )}
      </View>

      <View style={styles.bottomDock}>
        <View style={styles.controlPill}>
          <Pressable
            disabled={simulatorMediaDisabled}
            onPress={() => {
              if (simulatorMediaDisabled) {
                Alert.alert("Media unavailable", getIosSimulatorMediaMessage());
                return;
              }

              void runAsync(media.toggleAudio);
            }}
            style={({ pressed }) => [styles.controlButton, isMuted && styles.controlButtonDanger, simulatorMediaDisabled && styles.controlButtonDisabled, pressed && styles.controlButtonPressed]}
          >
            <HugeiconsIcon color={isMuted ? "white" : Theme.colors.primary} icon={isMuted ? MicOff01Icon : Mic01Icon} size={22} />
          </Pressable>
          <Pressable
            disabled={simulatorMediaDisabled}
            onPress={() => {
              if (simulatorMediaDisabled) {
                Alert.alert("Media unavailable", getIosSimulatorMediaMessage());
                return;
              }

              void runAsync(media.toggleVideo);
            }}
            style={({ pressed }) => [styles.controlButton, isCameraOff && styles.controlButtonDanger, simulatorMediaDisabled && styles.controlButtonDisabled, pressed && styles.controlButtonPressed]}
          >
            <HugeiconsIcon color={isCameraOff ? "white" : Theme.colors.primary} icon={isCameraOff ? VideoOffIcon : Video01Icon} size={22} />
          </Pressable>
          <Pressable onPress={() => openPanel("chat")} style={({ pressed }) => [styles.controlButton, pressed && styles.controlButtonPressed]}>
            <HugeiconsIcon color="white" icon={Chat01Icon} size={22} />
            {chat.unreadCount > 0 ? (
              <View style={styles.controlBadge}>
                <Text style={styles.controlBadgeText}>{chat.unreadCount > 9 ? "9+" : String(chat.unreadCount)}</Text>
              </View>
            ) : null}
          </Pressable>
          <Pressable onPress={() => setActionsOpen(true)} style={({ pressed }) => [styles.controlButton, pressed && styles.controlButtonPressed]}>
            <HugeiconsIcon color="white" icon={MoreHorizontalIcon} size={22} />
          </Pressable>
          <Pressable onPress={handleLeave} style={({ pressed }) => [styles.controlButton, styles.controlButtonEndCall, pressed && styles.controlButtonPressed]}>
            <HugeiconsIcon color="white" icon={CallEnd01Icon} size={22} />
          </Pressable>
        </View>
      </View>

      <NativeMeetingActionsSheet
        chatEnabled={canChat}
        chatUnreadCount={chat.unreadCount}
        isHandRaised={handRaised}
        isScreenSharing={screenShare.isLocalSharing}
        onClose={() => setActionsOpen(false)}
        onInviteParticipants={handleInviteParticipants}
        onLeaveMeeting={() => {
          setActionsOpen(false);
          handleLeave();
        }}
        onOpenChat={() => openPanel("chat")}
        onOpenParticipants={() => openPanel("participants")}
        onOpenReactions={() => {
          setActionsOpen(false);
          setReactionPickerOpen(true);
        }}
        onOpenSettings={() => openPanel("settings")}
        onToggleScreenShare={() => void runAsync(() => screenShare.toggle())}
        onOpenTranscripts={() => openPanel("transcripts")}
        onOpenWhiteboard={() => openPanel("whiteboard")}
        onToggleHand={() => {
          setActionsOpen(false);
          if (canHandRaise) {
            interactions.toggleHand();
          }
        }}
        participantCount={participants.participantCount}
        peopleEnabled={canParticipants}
        raisedHandCount={raisedHandCount}
        settingsEnabled={canSettings}
        screenShareEnabled={canScreenShare}
        transcriptsEnabled={canTranscripts}
        visible={actionsOpen}
        whiteboardEnabled={canWhiteboard}
      />

      <NativeReactionPicker
        isOpen={reactionPickerOpen}
        onClose={() => setReactionPickerOpen(false)}
        onSelect={(emoji) => {
          if (!canReactions) {
            return;
          }

          interactions.sendReaction(emoji as ReactionEmoji);
        }}
      />

      <NativeMeetingPanel
        cameras={devices.cameras}
        chatDraft={chatDraft}
        isHost={isHost}
        isRefreshingDevices={devices.isLoading}
        localParticipantId={participants.localParticipant?.id ?? null}
        messages={chat.messages}
        microphones={devices.microphones}
        onChatDraftChange={setChatDraft}
        onClearWhiteboard={whiteboard.clear}
        onClose={closePanel}
        onMuteParticipant={muteParticipant}
        onRefreshDevices={() => void runAsync(devices.refreshDevices)}
        onRemoveParticipant={(participantId) => void runAsync(() => removeParticipant(participantId))}
        onRequestWhiteboardSync={whiteboard.requestSync}
        onSelectCamera={(deviceId) => void runAsync(() => devices.selectCamera(deviceId))}
        onSelectMicrophone={(deviceId) => void runAsync(() => devices.selectMicrophone(deviceId))}
        onSelectSpeaker={(deviceId) => void runAsync(() => devices.selectSpeaker(deviceId))}
        onSendMessage={() => {
          if (!chatDraft.trim()) {
            return;
          }
          chat.sendMessage(chatDraft.trim());
          setChatDraft("");
        }}
        onToggleWhiteboard={whiteboard.toggle}
        onUnmuteParticipant={unmuteParticipant}
        panel={panel}
        participants={participants.participants as readonly RoomParticipant[]}
        selectedCamera={devices.selectedCamera}
        selectedMicrophone={devices.selectedMicrophone}
        selectedSpeaker={devices.selectedSpeaker}
        speakers={devices.speakers}
        transcripts={transcripts.transcripts}
        whiteboardCanDraw={whiteboard.canDraw}
        whiteboardElementCount={whiteboard.elements.length}
        whiteboardOpen={whiteboard.isOpen}
        whiteboardParticipantCount={whiteboard.openParticipants.length}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  roomScreen: {
    flex: 1,
    backgroundColor: "#000000",
    paddingHorizontal: 0,
  },
  topBar: {
    paddingTop: Platform.OS === "ios" ? 54 : 42,
    paddingBottom: 14,
    paddingHorizontal: 24,
    backgroundColor: "#000000",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    width: "100%",
  },
  topBarLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  connectionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Theme.colors.success,
  },
  topBarRoomName: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: -0.2,
  },
  timerBadge: {
    backgroundColor: "rgba(255,255,255,0.1)",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 4,
  },
  timerText: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 11,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  topBarRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
  },
  topBarCount: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "800",
  },
  stageFrame: {
    flex: 1,
    backgroundColor: "#000000",
    width: "100%",
    borderRadius: 24,
    overflow: "hidden",
    justifyContent: "center",
  },
  bottomDock: {
    paddingTop: 20,
    paddingBottom: Platform.OS === "ios" ? 38 : 24,
    paddingHorizontal: 24,
    backgroundColor: "#000000",
    borderTopWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    width: "100%",
  },
  controlPill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
  },
  controlButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  controlButtonDisabled: {
    opacity: 0.45,
  },
  controlButtonPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.92 }],
  },
  controlButtonDanger: {
    backgroundColor: "#ea4335",
  },
  controlButtonEndCall: {
    backgroundColor: "#ef4444",
    width: 68,
    borderRadius: 18,
  },
  controlBadge: {
    position: "absolute",
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: "#000000",
  },
  controlBadgeText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "800",
  },
});
