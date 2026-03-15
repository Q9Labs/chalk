import type { LayoutMode, ParticipantState, ReactionEmoji } from "@q9labs/chalk-core";
import { getParticipantColor, getParticipantInitial } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import {
  CallEnd01Icon,
  ComputerScreenShareIcon,
  MoreHorizontalIcon,
  Mic01Icon,
  MicOff01Icon,
  SmileIcon,
  Video01Icon,
  VideoOffIcon,
  WavingHand01Icon,
} from "@hugeicons/core-free-icons";
import { useChalkSession } from "../context/chalk-native-provider";
import { useChat } from "../hooks/useChat";
import { useDevices } from "../hooks/useDevices";
import { useInteractions } from "../hooks/useInteractions";
import { useLayout } from "../hooks/useLayout";
import { useMedia } from "../hooks/useMedia";
import { usePanels } from "../hooks/usePanels";
import { useParticipants } from "../hooks/useParticipants";
import { useScreenShare } from "../hooks/useScreenShare";
import { useTranscripts } from "../hooks/useTranscripts";
import { useWhiteboard } from "../hooks/useWhiteboard";
import { Theme } from "../ui/theme";
import { NativeFaceAvatar } from "./NativeFaceAvatar";
import { NativeGradientSurface } from "./NativeGradientSurface";
import { NativeMediaView } from "./NativeMediaView";
import { NativeMeetingPanel, type NativeMeetingPanelName } from "./NativeMeetingPanel";
import { NativeReactionPicker } from "./NativeReactionPicker";

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

export function NativeMeetingRoom({ onLeave }: NativeMeetingRoomProps): React.JSX.Element {
  const { removeParticipant, muteParticipant, unmuteParticipant } = useChalkSession();
  const media = useMedia();
  const devices = useDevices();
  const participants = useParticipants();
  const chat = useChat();
  const transcripts = useTranscripts();
  const interactions = useInteractions();
  const screenShare = useScreenShare();
  const layout = useLayout();
  const panels = usePanels();
  const whiteboard = useWhiteboard();

  const [chatDraft, setChatDraft] = useState("");
  const [sheetPanel, setSheetPanel] = useState<NativeMeetingPanelName | null>(null);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);

  const isHost = (participants.localParticipant?.role ?? "participant") === "host";
  const panel = sheetPanel ?? (panels.activePanel as Exclude<typeof panels.activePanel, null> | null);
  const stageParticipant = useMemo(
    () => pickStageParticipant(screenShare.sharerParticipantId, participants.remoteParticipants, participants.localParticipant, participants.activeSpeaker),
    [screenShare.sharerParticipantId, participants.remoteParticipants, participants.localParticipant, participants.activeSpeaker],
  );
  const stageTrack = screenShare.isActive
    ? screenShare.videoTrack ?? stageParticipant?.screenShareTrack ?? stageParticipant?.videoTrack ?? null
    : stageParticipant?.videoTrack ?? participants.localParticipant?.videoTrack ?? null;

  useEffect(() => {
    if (panels.activePanel === "chat") {
      chat.markAsRead();
    }
  }, [panels.activePanel, chat]);

  const runAsync = useCallback(async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (cause) {
      console.warn("NativeMeetingRoom async action failed:", cause);
    }
  }, []);

  const openSheet = useCallback(
    (nextPanel: NativeMeetingPanelName) => {
      if (nextPanel === "transcripts") {
        panels.closePanel();
        setSheetPanel((current) => (current === "transcripts" ? null : "transcripts"));
        return;
      }

      setSheetPanel(null);
      panels.togglePanel(nextPanel);
    },
    [panels],
  );

  const closeSheet = useCallback(() => {
    setSheetPanel(null);
    panels.closePanel();
  }, [panels]);

  const stageName = stageParticipant?.displayName || "Participant";
  const selfName = participants.localParticipant?.displayName || "Guest";
  const isMuted = !media.isAudioEnabled;
  const isCameraOff = !media.isVideoEnabled;
  const handRaised = interactions.isHandRaised;
  const selfColors = useMemo(() => getParticipantColor(selfName), [selfName]);

  return (
    <View style={styles.roomScreen}>
      <View style={styles.stageFrame}>
        {layout.layout === "grid" ? (
          <View style={styles.grid}>
            {participants.participants.map((participant) => (
              <View key={participant.id} style={styles.gridTile}>
                <NativeMediaView label={participant.displayName} participant={participant as RoomParticipant} track={participant.videoTrack ?? participant.screenShareTrack} />
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.stageSurface}>
            <NativeGradientSurface borderRadius={36} participantId={stageName} />
            {stageTrack ? (
              <View style={styles.stageVideoContainer}>
                <NativeMediaView participant={stageParticipant as RoomParticipant} track={stageTrack} zOrder={0} />
              </View>
            ) : (
              <View style={styles.stageCenter}>
                <NativeFaceAvatar name={stageName} size={160} />
              </View>
            )}

            <View style={styles.selfPill}>
              <View style={[styles.selfAvatar, { backgroundColor: selfColors.primary }]}>
                <Text style={styles.selfAvatarText}>{getParticipantInitial(selfName)}</Text>
              </View>
              <Text style={styles.selfPillName}>{isHost ? "Host" : selfName}</Text>
              {isMuted ? (
                <View style={styles.micOffIndicator}>
                  <HugeiconsIcon color="white" icon={MicOff01Icon} size={10} />
                </View>
              ) : null}
            </View>
          </View>
        )}
      </View>

      <View style={styles.bottomDock}>
        <View style={styles.controlPill}>
          <Pressable onPress={() => void runAsync(media.toggleAudio)} style={[styles.controlButton, isMuted && styles.controlButtonDanger]}>
            <HugeiconsIcon color="white" icon={isMuted ? MicOff01Icon : Mic01Icon} size={24} />
          </Pressable>
          <Pressable onPress={() => void runAsync(media.toggleVideo)} style={[styles.controlButton, isCameraOff && styles.controlButtonDanger]}>
            <HugeiconsIcon color="white" icon={isCameraOff ? VideoOffIcon : Video01Icon} size={24} />
          </Pressable>
        </View>

        <View style={styles.controlPill}>
          <Pressable onPress={() => void runAsync(() => screenShare.toggle())} style={[styles.controlButton, screenShare.isLocalSharing && styles.controlButtonActive]}>
            <HugeiconsIcon color="white" icon={ComputerScreenShareIcon} size={24} />
          </Pressable>
          <Pressable onPress={interactions.toggleHand} style={[styles.controlButton, handRaised && styles.controlButtonActive]}>
            <HugeiconsIcon color={handRaised ? Theme.colors.primary : "white"} icon={WavingHand01Icon} size={24} />
          </Pressable>
          <Pressable onPress={() => setReactionPickerOpen(true)} style={styles.controlButton}>
            <HugeiconsIcon color="#facc15" icon={SmileIcon} size={24} />
          </Pressable>
        </View>

        <View style={styles.controlPill}>
          <Pressable onPress={() => openSheet("settings")} style={styles.controlButton}>
            <HugeiconsIcon color="white" icon={MoreHorizontalIcon} size={24} />
          </Pressable>
          <Pressable onPress={() => void runAsync(async () => onLeave())} style={[styles.controlButton, styles.controlButtonEndCall]}>
            <HugeiconsIcon color="white" icon={CallEnd01Icon} size={24} />
          </Pressable>
        </View>
      </View>

      <NativeReactionPicker
        isOpen={reactionPickerOpen}
        onClose={() => setReactionPickerOpen(false)}
        onSelect={(emoji) => interactions.sendReaction(emoji as ReactionEmoji)}
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
        onClose={closeSheet}
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

function pickStageParticipant(
  sharerParticipantId: string | null,
  remoteParticipants: readonly RoomParticipant[],
  localParticipant: RoomParticipant | null,
  activeSpeaker: RoomParticipant | null,
): RoomParticipant | null {
  if (sharerParticipantId) {
    return remoteParticipants.find((participant) => participant.id === sharerParticipantId) ?? localParticipant;
  }

  return activeSpeaker ?? remoteParticipants.find((participant) => participant.videoTrack) ?? remoteParticipants[0] ?? localParticipant;
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
    backgroundColor: "#101314",
  },
  stageSurface: {
    flex: 1,
    backgroundColor: "#0f172a",
  },
  stageVideoContainer: {
    flex: 1,
    borderRadius: 36,
    overflow: "hidden",
  },
  stageCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  selfPill: {
    position: "absolute",
    left: 16,
    bottom: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 4,
    paddingRight: 10,
    paddingVertical: 4,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  selfAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  selfAvatarText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "700",
  },
  selfPillName: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "600",
  },
  micOffIndicator: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "#ef4444",
    alignItems: "center",
    justifyContent: "center",
  },
  bottomDock: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 12,
    gap: 6,
    width: "100%",
  },
  controlPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#111111",
    borderRadius: 32,
    padding: 4,
    gap: 2,
  },
  controlButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  controlButtonActive: {
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  controlButtonDanger: {
    backgroundColor: "#ef4444",
  },
  controlButtonEndCall: {
    backgroundColor: "#ef4444",
    width: 52,
  },
  grid: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Theme.spacing.md,
    padding: 16,
  },
  gridTile: {
    width: "48.5%",
    aspectRatio: 0.78,
  },
});
