import type { LayoutMode, ParticipantState, ReactionEmoji } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useChalkSession } from "../context/chalk-native-provider";
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
import { NativeMediaView } from "./NativeMediaView";
import { NativeMeetingPanel, type NativeMeetingPanelName } from "./NativeMeetingPanel";

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

const REACTION_EMOJIS: readonly ReactionEmoji[] = ["👍", "🎉", "❤️", "😂"];

export function NativeMeetingRoom({ roomName, features, onLeave, onEndForAll }: NativeMeetingRoomProps): React.JSX.Element {
  const enabled = { chat: true, participants: true, transcripts: true, settings: true, screenShare: true, recording: true, reactions: true, handRaise: true, whiteboard: true, ...features };
  const { removeParticipant, muteParticipant, unmuteParticipant } = useChalkSession();
  const room = useRoom();
  const media = useMedia();
  const devices = useDevices();
  const participants = useParticipants();
  const chat = useChat();
  const transcripts = useTranscripts();
  const interactions = useInteractions();
  const recording = useRecording();
  const screenShare = useScreenShare();
  const layout = useLayout();
  const panels = usePanels();
  const whiteboard = useWhiteboard();
  const [chatDraft, setChatDraft] = useState("");
  const [sheetPanel, setSheetPanel] = useState<NativeMeetingPanelName | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isHost = (participants.localParticipant?.role ?? "participant") === "host";
  const panel = sheetPanel ?? (panels.activePanel as Exclude<typeof panels.activePanel, null> | null);
  const stageParticipant = useMemo(
    () => pickStageParticipant(screenShare.sharerParticipantId, participants.remoteParticipants, participants.localParticipant, participants.activeSpeaker),
    [screenShare.sharerParticipantId, participants.remoteParticipants, participants.localParticipant, participants.activeSpeaker],
  );
  const stageTrack = screenShare.isActive ? screenShare.videoTrack ?? stageParticipant?.screenShareTrack ?? stageParticipant?.videoTrack ?? null : stageParticipant?.videoTrack ?? participants.localParticipant?.videoTrack ?? null;
  const localPreviewTrack = participants.localParticipant?.videoTrack ?? null;

  useEffect(() => {
    if (panels.activePanel === "chat") {
      chat.markAsRead();
    }
  }, [panels.activePanel, chat]);

  const runAsync = useCallback(async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed");
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

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>{room.status === "reconnecting" ? "Reconnecting" : "Meeting room"}</Text>
          <Text style={styles.title}>{roomName || room.roomName || room.roomId || "Chalk meeting"}</Text>
        </View>
        <Text style={styles.meta}>{participants.participantCount} people</Text>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.stageArea}>
        {layout.layout === "grid" ? (
          <ScrollView contentContainerStyle={styles.grid}>
            {participants.participants.map((participant) => (
              <View key={participant.id} style={styles.gridTile}>
                <NativeMediaView label={participant.displayName} participant={participant as any} track={participant.videoTrack ?? participant.screenShareTrack} />
              </View>
            ))}
          </ScrollView>
        ) : (
          <>
            <NativeMediaView emphasizeMuted label={screenShare.isActive ? `${stageParticipant?.displayName || "Participant"} presenting` : undefined} participant={stageParticipant as any} track={stageTrack} />
            {participants.localParticipant && stageParticipant?.id !== participants.localParticipant.id ? (
              <View style={styles.localPreview}>
                <NativeMediaView emphasizeMuted label="You" mirror participant={participants.localParticipant as any} track={localPreviewTrack} />
              </View>
            ) : null}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
              {participants.remoteParticipants.map((participant) => (
                <View key={participant.id} style={styles.stripTile}>
                  <NativeMediaView label={participant.displayName} participant={participant as any} track={participant.screenShareTrack ?? participant.videoTrack} />
                </View>
              ))}
            </ScrollView>
          </>
        )}
      </View>

      {interactions.activeReactions.length > 0 ? (
        <View style={styles.reactionRow}>
          {interactions.activeReactions.slice(0, 4).map((reaction) => (
            <View key={`${reaction.participantId}-${reaction.timestamp.toISOString()}`} style={styles.reactionBadge}>
              <Text style={styles.reactionText}>{reaction.emoji}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.controls}>
        <ControlButton active={media.isAudioEnabled} label={media.isAudioEnabled ? "Mic on" : "Mic off"} onPress={() => void runAsync(media.toggleAudio)} />
        <ControlButton active={media.isVideoEnabled} label={media.isVideoEnabled ? "Cam on" : "Cam off"} onPress={() => void runAsync(media.toggleVideo)} />
        {enabled.screenShare ? <ControlButton active={screenShare.isLocalSharing} label={screenShare.isLocalSharing ? "Stop share" : "Share"} onPress={() => void runAsync(() => screenShare.toggle())} /> : null}
        {enabled.recording ? <ControlButton active={recording.isRecording} label={recording.isRecording ? `Recording ${recording.durationSeconds}s` : "Record"} onPress={() => void runAsync(recording.toggle)} /> : null}
        {enabled.handRaise ? <ControlButton active={interactions.isHandRaised} label={interactions.isHandRaised ? "Lower hand" : "Raise hand"} onPress={interactions.toggleHand} /> : null}
        {enabled.reactions ? REACTION_EMOJIS.map((emoji) => <ControlButton key={emoji} label={emoji} onPress={() => interactions.sendReaction(emoji)} />) : null}
        {enabled.chat ? <ControlButton active={panel === "chat"} label={`Chat ${chat.unreadCount > 0 ? `(${chat.unreadCount})` : ""}`.trim()} onPress={() => openSheet("chat")} /> : null}
        {enabled.participants ? <ControlButton active={panel === "participants"} label="People" onPress={() => openSheet("participants")} /> : null}
        {enabled.transcripts ? <ControlButton active={panel === "transcripts"} label="Transcript" onPress={() => openSheet("transcripts")} /> : null}
        {enabled.settings ? <ControlButton active={panel === "settings"} label={layout.layout === "grid" ? "Grid" : "Layout"} onPress={() => openSheet("settings")} /> : null}
        {enabled.whiteboard ? <ControlButton active={panel === "whiteboard" || whiteboard.isOpen} label="Whiteboard" onPress={() => openSheet("whiteboard")} /> : null}
        <ControlButton label="Leave" tone="danger" onPress={() => void runAsync(async () => onLeave())} />
        {isHost && onEndForAll ? <ControlButton label="End for all" tone="danger" onPress={() => void runAsync(async () => onEndForAll())} /> : null}
      </ScrollView>

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

function ControlButton({
  label,
  onPress,
  active = false,
  tone = "neutral",
}: {
  label: string;
  onPress: () => void;
  active?: boolean;
  tone?: "neutral" | "danger";
}): React.JSX.Element {
  return (
    <Pressable onPress={onPress} style={[styles.controlButton, active && styles.controlButtonActive, tone === "danger" && styles.controlButtonDanger]}>
      <Text style={styles.controlButtonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Theme.colors.background,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: Theme.spacing.lg,
    paddingTop: Theme.spacing["3xl"],
    paddingBottom: Theme.spacing.md,
  },
  eyebrow: {
    ...Theme.typography.eyebrow,
    color: Theme.colors.primary,
  },
  title: {
    ...Theme.typography.heading,
    color: Theme.colors.foreground,
  },
  meta: {
    ...Theme.typography.meta,
    color: Theme.colors.mutedForeground,
  },
  error: {
    ...Theme.typography.meta,
    color: Theme.colors.error,
    paddingHorizontal: Theme.spacing.lg,
    paddingBottom: Theme.spacing.sm,
  },
  stageArea: {
    flex: 1,
    paddingHorizontal: Theme.spacing.lg,
    paddingBottom: Theme.spacing.md,
    gap: Theme.spacing.md,
  },
  localPreview: {
    position: "absolute",
    right: Theme.spacing["2xl"],
    bottom: Theme.spacing["2xl"],
    width: 108,
    height: 144,
  },
  strip: {
    gap: Theme.spacing.sm,
  },
  stripTile: {
    width: 120,
    height: 84,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Theme.spacing.md,
  },
  gridTile: {
    width: "48.5%",
    aspectRatio: 0.78,
  },
  reactionRow: {
    flexDirection: "row",
    gap: Theme.spacing.sm,
    paddingHorizontal: Theme.spacing.lg,
    paddingBottom: Theme.spacing.sm,
  },
  reactionBadge: {
    borderRadius: Theme.radius.full,
    backgroundColor: Theme.colors.glassSurface,
    paddingHorizontal: Theme.spacing.md,
    paddingVertical: Theme.spacing.sm,
  },
  reactionText: {
    fontSize: 20,
  },
  controls: {
    gap: Theme.spacing.sm,
    paddingHorizontal: Theme.spacing.lg,
    paddingBottom: Theme.spacing.md,
  },
  controlButton: {
    borderRadius: Theme.radius.full,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    backgroundColor: Theme.colors.controlsBackground,
    paddingHorizontal: Theme.spacing.md,
    paddingVertical: Theme.spacing.md,
  },
  controlButtonActive: {
    backgroundColor: Theme.colors.primary,
    borderColor: Theme.colors.primary,
  },
  controlButtonDanger: {
    backgroundColor: Theme.colors.error,
    borderColor: Theme.colors.error,
  },
  controlButtonText: {
    color: Theme.colors.foreground,
    fontSize: 13,
    fontWeight: "700",
  },
});
