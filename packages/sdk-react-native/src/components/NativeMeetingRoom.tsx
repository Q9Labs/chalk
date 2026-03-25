import type { LayoutMode, ParticipantState, ReactionEmoji } from "@q9labs/chalk-core";
import { CallEnd01Icon, ComputerScreenShareIcon, Mic01Icon, MicOff01Icon, MoreHorizontalIcon, Video01Icon, VideoOffIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, Share, StyleSheet, Text, View } from "react-native";
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
import { NativeMeetingActionsSheet } from "./NativeMeetingActionsSheet";
import { NativeMeetingPanel, type NativeMeetingPanelName } from "./NativeMeetingPanel";
import { NativeReactionPicker } from "./NativeReactionPicker";
import { NativeMeetingGrid } from "./native-meeting-room/NativeMeetingGrid";
import { NativeMeetingStage } from "./native-meeting-room/NativeMeetingStage";
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
}

export function NativeMeetingRoom({ features, onLeave }: NativeMeetingRoomProps): React.JSX.Element {
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

  useEffect(() => {
    if (panel === "chat") {
      chat.markAsRead();
    }
  }, [panel, chat]);

  const runAsync = useCallback(async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (cause) {
      console.warn("NativeMeetingRoom async action failed:", cause);
    }
  }, []);

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
          <NativeMeetingGrid gridPages={derived.gridPages} isCompactViewport={derived.isCompactViewport} layoutMode={layout.layout} participants={derived.allParticipants} />
        )}
      </View>

      <View style={styles.bottomDock}>
        <View style={styles.controlPill}>
          <Pressable onPress={() => void runAsync(media.toggleAudio)} style={[styles.controlButton, isMuted && styles.controlButtonDanger]}>
            <HugeiconsIcon color="#ffffff" icon={isMuted ? MicOff01Icon : Mic01Icon} size={24} />
          </Pressable>
          <Pressable onPress={() => void runAsync(media.toggleVideo)} style={[styles.controlButton, isCameraOff && styles.controlButtonDanger]}>
            <HugeiconsIcon color="#ffffff" icon={isCameraOff ? VideoOffIcon : Video01Icon} size={24} />
          </Pressable>
          {canScreenShare ? (
            <Pressable onPress={() => void runAsync(() => screenShare.toggle())} style={[styles.controlButton, screenShare.isLocalSharing && styles.controlButtonActive]}>
              <HugeiconsIcon color="#ffffff" icon={ComputerScreenShareIcon} size={24} />
            </Pressable>
          ) : null}
          <Pressable onPress={() => setActionsOpen(true)} style={styles.controlButton}>
            <HugeiconsIcon color="#ffffff" icon={MoreHorizontalIcon} size={24} />
            {chat.unreadCount > 0 ? (
              <View style={styles.controlBadge}>
                <Text style={styles.controlBadgeText}>{chat.unreadCount > 9 ? "9+" : String(chat.unreadCount)}</Text>
              </View>
            ) : null}
          </Pressable>
          <Pressable onPress={() => void runAsync(async () => onLeave())} style={[styles.controlButton, styles.controlButtonEndCall]}>
            <HugeiconsIcon color="#ffffff" icon={CallEnd01Icon} size={24} />
          </Pressable>
        </View>
      </View>

      <NativeMeetingActionsSheet
        chatEnabled={canChat}
        chatUnreadCount={chat.unreadCount}
        isCameraOff={isCameraOff}
        isHandRaised={handRaised}
        isMuted={isMuted}
        isRecording={recording.isRecording}
        isScreenSharing={screenShare.isLocalSharing}
        onClose={() => setActionsOpen(false)}
        onInviteParticipants={handleInviteParticipants}
        onLeaveMeeting={() => {
          setActionsOpen(false);
          void runAsync(async () => onLeave());
        }}
        onOpenChat={() => openPanel("chat")}
        onOpenParticipants={() => openPanel("participants")}
        onOpenReactions={() => {
          setActionsOpen(false);
          setReactionPickerOpen(true);
        }}
        onOpenSettings={() => openPanel("settings")}
        onOpenTranscripts={() => openPanel("transcripts")}
        onOpenWhiteboard={() => openPanel("whiteboard")}
        onToggleAudio={() => void runAsync(media.toggleAudio)}
        onToggleHand={() => {
          setActionsOpen(false);
          if (canHandRaise) {
            interactions.toggleHand();
          }
        }}
        onToggleRecording={() => void runAsync(() => recording.toggle())}
        onToggleScreenShare={() => void runAsync(() => screenShare.toggle())}
        onToggleVideo={() => void runAsync(media.toggleVideo)}
        participantCount={participants.participantCount}
        peopleEnabled={canParticipants}
        raisedHandCount={raisedHandCount}
        recordingEnabled={canRecording}
        screenShareEnabled={canScreenShare}
        settingsEnabled={canSettings}
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
        layout={layout.layout}
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
        onSetLayout={(nextLayout: LayoutMode) => layout.setLayout(nextLayout)}
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
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: Platform.OS === "ios" ? 34 : 20,
  },
  stageFrame: {
    flex: 1,
    borderRadius: 36,
    overflow: "hidden",
    backgroundColor: Theme.colors.stageBackground,
  },
  bottomDock: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: Platform.OS === "ios" ? 22 : 10,
    alignItems: "center",
    pointerEvents: "box-none",
  },
  controlPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: Theme.colors.controlsBackground,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  controlButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  controlButtonDanger: {
    backgroundColor: "rgba(239,68,68,0.24)",
  },
  controlButtonActive: {
    backgroundColor: "rgba(27,182,166,0.24)",
  },
  controlButtonEndCall: {
    backgroundColor: "rgba(239,68,68,0.92)",
  },
  controlBadge: {
    position: "absolute",
    top: 6,
    right: 4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  controlBadgeText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "800",
  },
});
