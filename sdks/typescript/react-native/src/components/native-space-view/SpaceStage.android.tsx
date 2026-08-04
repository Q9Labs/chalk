import type { Layout } from "../../ui/native-types";
import ComputerScreenShareIcon from "@hugeicons/core-free-icons/dist/esm/ComputerScreenShareIcon";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import Presentation01Icon from "@hugeicons/core-free-icons/dist/esm/Presentation01Icon";
import WavingHand01Icon from "@hugeicons/core-free-icons/dist/esm/WavingHand01Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { FlatList, StyleSheet, Text, View } from "react-native";
import type { SpacePrimaryContent } from "../../utils/native-space-layout";
import { Theme } from "../../ui/theme";
import { useNativeTheme } from "../../ui/native-theme";
import { GradientSurface } from "../GradientSurface";
import { MediaView } from "../MediaView";
import type { SpaceParticipant } from "./types";

export interface SpaceStageProps {
  layoutMode: Layout;
  isCompactViewport: boolean;
  primaryContent: SpacePrimaryContent;
  screenSharer: SpaceParticipant | null;
  screenShareTrack: MediaStreamTrack | null;
  stripParticipants: readonly SpaceParticipant[];
  selfName: string;
  isMuted: boolean;
  handRaised: boolean;
  raisedHandCount: number;
  activeReactions: readonly { id: string; emoji: string; participantName: string }[];
  whiteboard: {
    isOpen: boolean;
    canDraw: boolean;
    elementCount: number;
    participantCount: number;
  };
}

function getParticipantStripTrack(participant: SpaceParticipant): MediaStreamTrack | null {
  return participant.videoTrack ?? null;
}

function StageSurface({ children }: { children: React.ReactNode }): React.JSX.Element {
  const theme = useNativeTheme();
  return <View style={[styles.surface, { backgroundColor: theme.colors.stageBackground }]}>{children}</View>;
}

function InfoChip({ icon, label, align = "left" }: { icon: React.ComponentProps<typeof HugeiconsIcon>["icon"]; label: string; align?: "left" | "right" }): React.JSX.Element {
  const theme = useNativeTheme();
  return (
    <View style={[styles.infoChip, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }, align === "right" ? styles.infoChipRight : styles.infoChipLeft]}>
      <HugeiconsIcon color={theme.colors.foreground} icon={icon} size={14} />
      <Text style={[styles.infoChipText, { color: theme.colors.foreground }]}>{label}</Text>
    </View>
  );
}

function NativeWhiteboardPlaceholder({ whiteboard }: Pick<SpaceStageProps, "whiteboard">): React.JSX.Element {
  return (
    <StageSurface>
      <GradientSurface angle="diagonal" borderRadius={24} opacity={0.6} participantId="whiteboard-stage" />
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
      <GradientSurface angle="diagonal" borderRadius={24} opacity={0.4} participantId="local-presenting" />
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

function NativeParticipantStrip({ participants, vertical }: { participants: readonly SpaceParticipant[]; vertical: boolean }): React.JSX.Element {
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
          <MediaView emphasizeMuted participant={participant} track={getParticipantStripTrack(participant)} />
        </View>
      )}
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      windowSize={4}
    />
  );
}

export function SpaceStageAndroid({ layoutMode, isCompactViewport, primaryContent, screenSharer, screenShareTrack, stripParticipants, selfName, isMuted, handRaised, raisedHandCount, activeReactions, whiteboard }: SpaceStageProps): React.JSX.Element {
  const theme = useNativeTheme();
  const verticalStrip = !isCompactViewport && layoutMode === "focus";

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
            <MediaView participant={screenSharer} track={screenShareTrack} objectFit="contain" />
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
        <MediaView participant={screenSharer} track={screenShareTrack} label={screenSharer?.displayName || "Participant"} objectFit="contain" />
      </StageSurface>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.darkCanvas }, verticalStrip && styles.containerVertical]}>
      <View style={styles.primaryFrame}>
        {primaryStage}

        {raisedHandCount > 0 ? <InfoChip icon={WavingHand01Icon} label={raisedHandCount === 1 ? "1 hand raised" : `${raisedHandCount} hands raised`} /> : null}

        {activeReactions.length > 0 ? (
          <View style={styles.reactionRail}>
            {activeReactions.map((reaction, index) => (
              <View key={`${reaction.id}-${index}`} style={[styles.reactionBubble, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
                <Text style={styles.reactionEmoji}>{reaction.emoji}</Text>
                <Text numberOfLines={1} style={[styles.reactionName, { color: theme.colors.foreground }]}>
                  {reaction.participantName}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        <View style={[styles.identityBar, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          <Text style={[styles.nameLabel, { color: theme.colors.foreground }]} numberOfLines={1}>
            {selfName}
          </Text>
          {isMuted ? (
            <View style={styles.muteIndicator}>
              <HugeiconsIcon color={theme.colors.primaryForeground} icon={MicOff01Icon} size={10} />
            </View>
          ) : null}
          {handRaised ? (
            <View style={styles.handIndicator}>
              <HugeiconsIcon color={theme.colors.primaryForeground} icon={WavingHand01Icon} size={10} />
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

export { SpaceStageAndroid as SpaceStage };

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
    borderRadius: 24,
    overflow: "hidden",
  },
  splitStage: {
    flex: 1,
    flexDirection: "row",
    gap: 10,
  },
  splitPanel: {
    flex: 1,
  },
  placeholderCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Theme.spacing["3xl"],
    gap: 12,
  },
  presentingIconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.colors.whiteOverlay06,
    borderWidth: 1,
    borderColor: Theme.colors.whiteOverlay12,
    marginBottom: 8,
  },
  placeholderEyebrow: {
    fontSize: 11,
    fontWeight: "800",
    color: Theme.colors.primary,
    letterSpacing: 1,
  },
  placeholderTitle: {
    fontSize: 22,
    fontWeight: "800",
    color: Theme.colors.onDark,
    textAlign: "center",
    letterSpacing: -0.5,
  },
  placeholderCopy: {
    fontSize: 14,
    color: Theme.colors.whiteOverlay50,
    textAlign: "center",
    lineHeight: 20,
    paddingHorizontal: 20,
  },
  infoChip: {
    position: "absolute",
    top: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: Theme.colors.darkOverlay50,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Theme.colors.whiteOverlay06,
  },
  infoChipLeft: {
    left: 20,
  },
  infoChipRight: {
    right: 20,
  },
  infoChipText: {
    color: Theme.colors.onDark,
    fontSize: 12,
    fontWeight: "700",
  },
  reactionRail: {
    position: "absolute",
    right: 16,
    bottom: 24,
    gap: 8,
    maxWidth: 180,
  },
  reactionBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Theme.colors.darkOverlay45,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: Theme.colors.whiteOverlay08,
  },
  reactionEmoji: {
    fontSize: 16,
  },
  reactionName: {
    flex: 1,
    color: Theme.colors.onDark,
    fontSize: 12,
    fontWeight: "700",
  },
  identityBar: {
    position: "absolute",
    left: 20,
    bottom: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Theme.colors.darkOverlay50,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Theme.colors.whiteOverlay06,
    maxWidth: "70%",
  },
  nameLabel: {
    color: Theme.colors.onDark,
    fontSize: 12,
    fontWeight: "700",
  },
  muteIndicator: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Theme.colors.dangerStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  handIndicator: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Theme.colors.warning,
    alignItems: "center",
    justifyContent: "center",
  },
  stripShell: {
    minHeight: 96,
  },
  stripShellHorizontal: {
    height: 110,
  },
  stripShellVertical: {
    width: 110,
    marginLeft: 12,
  },
  stripContent: {
    gap: 10,
  },
  stripHorizontal: {
    paddingBottom: 8,
  },
  stripVertical: {
    paddingRight: 8,
  },
  stripTile: {
    overflow: "hidden",
    borderRadius: 18,
  },
  stripTileHorizontal: {
    width: 132,
    height: 100,
  },
  stripTileVertical: {
    width: 100,
    height: 132,
  },
});
