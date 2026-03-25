import type { LayoutMode, ParticipantState, ReactionEmoji } from "@q9labs/chalk-core";
import { getParticipantAvatarRecipe } from "@q9labs/chalk-core";
import { CallEnd01Icon, ComputerScreenShareIcon, Mic01Icon, MicOff01Icon, MoreHorizontalIcon, Video01Icon, VideoOffIcon, WavingHand01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { NativeFaceAvatar } from "./NativeFaceAvatar";
import { NativeGradientSurface } from "./NativeGradientSurface";
import { NativeMediaView } from "./NativeMediaView";
import { NativeMeetingActionsSheet } from "./NativeMeetingActionsSheet";
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

  const [actionsOpen, setActionsOpen] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [localPanel, setLocalPanel] = useState<NativeMeetingPanelName | null>(null);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);

  const isHost = (participants.localParticipant?.role ?? "participant") === "host";
  const panel = localPanel ?? (panels.activePanel as NativeMeetingPanelName | null);
  const stageParticipant = useMemo(
    () => pickStageParticipant(screenShare.sharerParticipantId, participants.remoteParticipants, participants.localParticipant, participants.activeSpeaker),
    [screenShare.sharerParticipantId, participants.remoteParticipants, participants.localParticipant, participants.activeSpeaker],
  );
  const stageTrack = screenShare.isActive ? (screenShare.videoTrack ?? stageParticipant?.screenShareTrack ?? stageParticipant?.videoTrack ?? null) : (stageParticipant?.videoTrack ?? participants.localParticipant?.videoTrack ?? null);

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

  const stageName = stageParticipant?.displayName || "Participant";
  const selfName = participants.localParticipant?.displayName || "Guest";
  const isMuted = !media.isAudioEnabled;
  const isCameraOff = !media.isVideoEnabled;
  const handRaised = interactions.isHandRaised;
  const raisedHandCount = interactions.raisedHandCount;
  const activeReactions = interactions.activeReactions.slice(-3);
  const selfAvatarRecipe = useMemo(() => getParticipantAvatarRecipe(selfName), [selfName]);
  const canChat = features?.chat !== false;
  const canParticipants = features?.participants !== false;
  const canTranscripts = features?.transcripts !== false;
  const canSettings = features?.settings !== false;
  const canScreenShare = features?.screenShare !== false;
  const canRecording = features?.recording !== false;
  const canReactions = features?.reactions !== false;
  const canHandRaise = features?.handRaise !== false;
  const canWhiteboard = features?.whiteboard !== false;

  return (
    <View style={styles.roomScreen}>
      <View style={styles.stageFrame}>
        {layout.layout === "grid" ? (
          <View style={styles.grid}>
            {participants.participants.map((participant) => (
              <View key={participant.id} style={styles.gridTile}>
                <NativeMediaView label={participant.displayName} participant={participant as RoomParticipant} track={participant.videoTrack ?? participant.screenShareTrack} />
                {participant.handRaised ? (
                  <View style={styles.gridHandBadge}>
                    <HugeiconsIcon color="#ffffff" icon={WavingHand01Icon} size={14} />
                  </View>
                ) : null}
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

            {raisedHandCount > 0 ? (
              <View style={styles.stageChip}>
                <HugeiconsIcon color="#ffffff" icon={WavingHand01Icon} size={14} />
                <Text style={styles.stageChipText}>{raisedHandCount === 1 ? "1 hand raised" : `${raisedHandCount} hands raised`}</Text>
              </View>
            ) : null}

            {recording.isRecording ? (
              <View style={styles.recordingChip}>
                <View style={styles.recordingDot} />
                <Text style={styles.recordingChipText}>REC</Text>
              </View>
            ) : null}

            {screenShare.isLocalSharing ? (
              <View style={styles.shareChip}>
                <HugeiconsIcon color="#ffffff" icon={ComputerScreenShareIcon} size={14} />
                <Text style={styles.shareChipText}>Sharing</Text>
              </View>
            ) : null}

            {activeReactions.length > 0 ? (
              <View style={styles.reactionRail}>
                {activeReactions.map((reaction) => (
                  <View key={reaction.id} style={styles.reactionBubble}>
                    <Text style={styles.reactionEmoji}>{reaction.emoji}</Text>
                    <Text numberOfLines={1} style={styles.reactionName}>
                      {reaction.participantName}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            <View style={styles.selfPill}>
              <View style={[styles.selfAvatar, { backgroundColor: selfAvatarRecipe.colors.primary }]}>
                <Text style={styles.selfAvatarText}>{selfAvatarRecipe.initials}</Text>
              </View>
              <Text style={styles.selfPillName}>{isHost ? "Host" : selfName}</Text>
              {handRaised ? (
                <View style={styles.handRaisedIndicator}>
                  <HugeiconsIcon color="#ffffff" icon={WavingHand01Icon} size={10} />
                </View>
              ) : null}
              {isMuted ? (
                <View style={styles.micOffIndicator}>
                  <HugeiconsIcon color="#ffffff" icon={MicOff01Icon} size={10} />
                </View>
              ) : null}
            </View>
          </View>
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

function pickStageParticipant(sharerParticipantId: string | null, remoteParticipants: readonly RoomParticipant[], localParticipant: RoomParticipant | null, activeSpeaker: RoomParticipant | null): RoomParticipant | null {
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
  stageChip: {
    position: "absolute",
    top: 16,
    left: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(17,25,40,0.88)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  stageChipText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
  },
  recordingChip: {
    position: "absolute",
    top: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(127,29,29,0.88)",
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#ff7b7b",
  },
  recordingChipText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
  },
  shareChip: {
    position: "absolute",
    top: 60,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(91,33,182,0.88)",
  },
  shareChipText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
  },
  reactionRail: {
    position: "absolute",
    top: 18,
    alignSelf: "center",
    gap: 8,
  },
  reactionBubble: {
    minWidth: 88,
    maxWidth: 160,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(9,15,24,0.88)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  reactionEmoji: {
    fontSize: 18,
  },
  reactionName: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
    maxWidth: 92,
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
  handRaisedIndicator: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "#8b5cf6",
    alignItems: "center",
    justifyContent: "center",
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
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  controlButtonActive: {
    backgroundColor: "#8b5cf6",
  },
  controlButtonDanger: {
    backgroundColor: "#ef4444",
  },
  controlButtonEndCall: {
    width: 56,
    backgroundColor: "#ef4444",
  },
  controlBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#8b5cf6",
  },
  controlBadgeText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "700",
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
    borderRadius: 24,
    overflow: "hidden",
  },
  gridHandBadge: {
    position: "absolute",
    top: 12,
    right: 12,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#8b5cf6",
    alignItems: "center",
    justifyContent: "center",
  },
});
