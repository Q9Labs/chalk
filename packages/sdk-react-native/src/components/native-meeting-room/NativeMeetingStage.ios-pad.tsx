import type { LayoutMode } from "@q9labs/chalk-core";
import ComputerScreenShareIcon from "@hugeicons/core-free-icons/dist/esm/ComputerScreenShareIcon";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import Presentation01Icon from "@hugeicons/core-free-icons/dist/esm/Presentation01Icon";
import RecordIcon from "@hugeicons/core-free-icons/dist/esm/RecordIcon";
import WavingHand01Icon from "@hugeicons/core-free-icons/dist/esm/WavingHand01Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { FlatList, Platform, StyleSheet, Text, View } from "react-native";
import type { NativeMeetingPrimaryContent } from "../../utils/native-meeting-layout";
import { Theme } from "../../ui/theme";
import { NativeGradientSurface } from "../NativeGradientSurface";
import { NativeMediaView } from "../NativeMediaView";
import type { RoomParticipant } from "./types";

export interface NativeMeetingStageProps {
  layoutMode: LayoutMode;
  isCompactViewport: boolean;
  primaryContent: NativeMeetingPrimaryContent;
  screenSharer: RoomParticipant | null;
  screenShareTrack: MediaStreamTrack | null;
  stripParticipants: readonly RoomParticipant[];
  isHost: boolean;
  selfName: string;
  isMuted: boolean;
  handRaised: boolean;
  raisedHandCount: number;
  isRecording: boolean;
  activeReactions: readonly { id: string; emoji: string; participantName: string }[];
  whiteboard: {
    isOpen: boolean;
    canDraw: boolean;
    elementCount: number;
    participantCount: number;
  };
}

function getParticipantStripTrack(participant: RoomParticipant): MediaStreamTrack | null {
  return participant.videoTrack ?? null;
}

function StageSurface({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <View style={styles.surface}>{children}</View>;
}

function InfoChip({ icon, label, align = "left" }: { icon: React.ComponentProps<typeof HugeiconsIcon>["icon"]; label: string; align?: "left" | "right" }): React.JSX.Element {
  return (
    <View style={[styles.infoChip, align === "right" ? styles.infoChipRight : styles.infoChipLeft]}>
      <HugeiconsIcon color="#ffffff" icon={icon} size={14} />
      <Text style={styles.infoChipText}>{label}</Text>
    </View>
  );
}

function NativeWhiteboardPlaceholder({ whiteboard }: Pick<NativeMeetingStageProps, "whiteboard">): React.JSX.Element {
  return (
    <StageSurface>
      <NativeGradientSurface angle="diagonal" borderRadius={24} opacity={0.6} participantId="whiteboard-stage" />
      <View style={styles.placeholderCenter}>
        <View style={styles.presentingIconCircle}>
          <HugeiconsIcon color={Theme.colors.primary} icon={Presentation01Icon} size={32} />
        </View>
        <Text style={styles.placeholderEyebrow}>SHARED CANVAS</Text>
        <Text style={styles.placeholderTitle}>Whiteboard active</Text>
        <Text style={styles.placeholderCopy}>{whiteboard.canDraw ? "Collaborative board is open." : "Board is open in view-only mode."}</Text>
      </View>
    </StageSurface>
  );
}

function NativeLocalSharePlaceholder(): React.JSX.Element {
  return (
    <StageSurface>
      <NativeGradientSurface angle="diagonal" borderRadius={24} opacity={0.4} participantId="local-presenting" />
      <View style={styles.placeholderCenter}>
        <View style={styles.presentingIconCircle}>
          <HugeiconsIcon color={Theme.colors.primary} icon={ComputerScreenShareIcon} size={32} />
        </View>
        <Text style={styles.placeholderEyebrow}>YOU ARE PRESENTING</Text>
        <Text style={styles.placeholderTitle}>Screen sharing active</Text>
        <Text style={styles.placeholderCopy}>Your preview is hidden here to prevent an infinite mirror effect. Everyone else can see your screen.</Text>
      </View>
    </StageSurface>
  );
}

function NativeParticipantStrip({ participants, vertical }: { participants: readonly RoomParticipant[]; vertical: boolean }): React.JSX.Element {
  return (
    <FlatList
      contentContainerStyle={[styles.stripContent, vertical ? styles.stripVertical : styles.stripHorizontal]}
      data={participants}
      horizontal={!vertical}
      initialNumToRender={vertical ? 4 : 5}
      keyExtractor={(participant, index) => `${participant.id}-${index}`}
      maxToRenderPerBatch={vertical ? 5 : 6}
      removeClippedSubviews
      renderItem={({ item: participant }) => (
        <View style={[styles.stripTile, vertical ? styles.stripTileVertical : styles.stripTileHorizontal]}>
          <NativeMediaView emphasizeMuted participant={participant} track={getParticipantStripTrack(participant)} />
        </View>
      )}
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      windowSize={4}
    />
  );
}

export function NativeMeetingStageIosPad({ layoutMode, isCompactViewport, primaryContent, screenSharer, screenShareTrack, stripParticipants, isHost, selfName, isMuted, handRaised, raisedHandCount, isRecording, activeReactions, whiteboard }: NativeMeetingStageProps): React.JSX.Element {
  const verticalStrip = !isCompactViewport && layoutMode === "speaker";

  let primaryStage: React.JSX.Element;
  if (primaryContent === "whiteboard") {
    primaryStage = <NativeWhiteboardPlaceholder whiteboard={whiteboard} />;
  } else if (primaryContent === "screen-share-placeholder") {
    primaryStage = <NativeLocalSharePlaceholder />;
  } else if (primaryContent === "split") {
    primaryStage = (
      <View style={styles.splitStage}>
        <View style={styles.splitPanel}>
          <StageSurface>
            <NativeMediaView participant={screenSharer} track={screenShareTrack} objectFit="contain" />
          </StageSurface>
        </View>
        <View style={styles.splitPanel}>
          <NativeWhiteboardPlaceholder whiteboard={whiteboard} />
        </View>
      </View>
    );
  } else {
    primaryStage = (
      <StageSurface>
        <NativeMediaView participant={screenSharer} track={screenShareTrack} label={screenSharer?.displayName || "Participant"} objectFit="contain" />
      </StageSurface>
    );
  }

  return (
    <View style={[styles.container, verticalStrip && styles.containerVertical]}>
      <View style={styles.primaryFrame}>
        {primaryStage}

        {raisedHandCount > 0 ? <InfoChip icon={WavingHand01Icon} label={raisedHandCount === 1 ? "1 hand raised" : `${raisedHandCount} hands raised`} /> : null}
        {isRecording ? <InfoChip align="right" icon={RecordIcon} label="REC" /> : null}

        {activeReactions.length > 0 ? (
          <View style={styles.reactionRail}>
            {activeReactions.map((reaction, index) => (
              <View key={`${reaction.id}-${index}`} style={styles.reactionBubble}>
                <Text style={styles.reactionEmoji}>{reaction.emoji}</Text>
                <Text numberOfLines={1} style={styles.reactionName}>
                  {reaction.participantName}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.identityBar}>
          <Text style={styles.nameLabel} numberOfLines={1}>
            {isHost ? "Host" : selfName}
          </Text>
          {isMuted ? (
            <View style={styles.muteIndicator}>
              <HugeiconsIcon color="#ffffff" icon={MicOff01Icon} size={10} />
            </View>
          ) : null}
          {handRaised ? (
            <View style={styles.handIndicator}>
              <HugeiconsIcon color="#ffffff" icon={WavingHand01Icon} size={10} />
            </View>
          ) : null}
        </View>
      </View>

      {stripParticipants.length > 0 ? (
        <View style={[styles.stripShell, verticalStrip ? styles.stripShellVertical : styles.stripShellHorizontal]}>
          <NativeParticipantStrip participants={stripParticipants} vertical={verticalStrip} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: "100%",
    paddingHorizontal: 12,
  },
  containerVertical: {
    flexDirection: "row",
  },
  primaryFrame: {
    flex: 1,
    minHeight: 0,
    width: "100%",
    marginBottom: 12,
  },
  surface: {
    flex: 1,
    backgroundColor: Theme.colors.stageBackground,
    width: "100%",
    borderRadius: 32,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  splitStage: {
    flex: 1,
    flexDirection: "row",
    gap: 16,
  },
  splitPanel: {
    flex: 1,
  },
  placeholderCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Theme.spacing["4xl"],
    gap: 16,
  },
  presentingIconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    marginBottom: 12,
  },
  placeholderEyebrow: {
    fontSize: 12,
    fontWeight: "800",
    color: Theme.colors.primary,
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  placeholderTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: "#ffffff",
    textAlign: "center",
    letterSpacing: -0.8,
  },
  placeholderCopy: {
    fontSize: 16,
    color: "rgba(255,255,255,0.5)",
    textAlign: "center",
    lineHeight: 24,
    paddingHorizontal: 40,
  },
  infoChip: {
    position: "absolute",
    top: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(10, 10, 12, 0.85)",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
  },
  infoChipLeft: {
    left: 24,
  },
  infoChipRight: {
    right: 24,
  },
  infoChipText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "800",
  },
  reactionRail: {
    position: "absolute",
    right: 24,
    bottom: 32,
    gap: 12,
    maxWidth: 220,
  },
  reactionBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(10, 10, 12, 0.85)",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
  },
  reactionEmoji: {
    fontSize: 20,
    fontFamily: Platform.OS === "ios" ? "Apple Color Emoji" : undefined,
  },
  reactionName: {
    flex: 1,
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "700",
  },
  identityBar: {
    position: "absolute",
    left: 24,
    bottom: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(10, 10, 12, 0.85)",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    maxWidth: "70%",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
  },
  nameLabel: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "800",
  },
  muteIndicator: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: Theme.colors.error,
    alignItems: "center",
    justifyContent: "center",
  },
  handIndicator: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: Theme.colors.warning,
    alignItems: "center",
    justifyContent: "center",
  },
  stripShell: {
    minHeight: 110,
  },
  stripShellHorizontal: {
    height: 160,
    paddingBottom: 48,
  },
  stripShellVertical: {
    width: 140,
    marginLeft: 16,
  },
  stripContent: {
    gap: 12,
  },
  stripHorizontal: {
    paddingBottom: 12,
  },
  stripVertical: {
    paddingRight: 12,
  },
  stripTile: {
    overflow: "hidden",
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  stripTileHorizontal: {
    width: 160,
    height: 120,
  },
  stripTileVertical: {
    width: 120,
    height: 160,
  },
});

