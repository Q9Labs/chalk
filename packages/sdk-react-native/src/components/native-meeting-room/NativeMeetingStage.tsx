import type { LayoutMode, ParticipantState } from "@q9labs/chalk-core";
import { getParticipantAvatarRecipe } from "@q9labs/chalk-core";
import { ComputerScreenShareIcon, MicOff01Icon, Presentation01Icon, RecordIcon, UserGroupIcon, WavingHand01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useMemo } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import type { NativeMeetingPrimaryContent } from "../../utils/native-meeting-layout";
import { Theme } from "../../ui/theme";
import { NativeGradientSurface } from "../NativeGradientSurface";
import { NativeMediaView } from "../NativeMediaView";

type RoomParticipant = ParticipantState["participants"][number];

interface NativeMeetingStageProps {
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
      <NativeGradientSurface angle="diagonal" borderRadius={Theme.radius["2xl"]} opacity={0.88} participantId="whiteboard-stage" />
      <View style={styles.placeholderCenter}>
        <View style={styles.placeholderIconCircle}>
          <HugeiconsIcon color="#ffffff" icon={Presentation01Icon} size={28} />
        </View>
        <Text style={styles.placeholderEyebrow}>Shared canvas</Text>
        <Text style={styles.placeholderTitle}>Whiteboard takes the stage</Text>
        <Text style={styles.placeholderCopy}>
          {whiteboard.canDraw ? "Collaborative board is open." : "Board is open in view-only mode."} {whiteboard.elementCount} elements · {whiteboard.participantCount} active.
        </Text>
      </View>
    </StageSurface>
  );
}

function NativeLocalSharePlaceholder({ screenSharer }: Pick<NativeMeetingStageProps, "screenSharer">): React.JSX.Element {
  return (
    <StageSurface>
      <NativeGradientSurface angle="diagonal" borderRadius={Theme.radius["2xl"]} opacity={0.9} participantId={screenSharer?.displayName || "local-share"} />
      <View style={styles.placeholderCenter}>
        <View style={styles.placeholderIconCircle}>
          <HugeiconsIcon color="#ffffff" icon={ComputerScreenShareIcon} size={28} />
        </View>
        <Text style={styles.placeholderEyebrow}>Screen share active</Text>
        <Text style={styles.placeholderTitle}>Preview hidden in this window</Text>
        <Text style={styles.placeholderCopy}>Chalk hides your own shared screen here so you do not get an infinite mirror effect.</Text>
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
      keyExtractor={(participant) => participant.id}
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

export function NativeMeetingStage({ layoutMode, isCompactViewport, primaryContent, screenSharer, screenShareTrack, stripParticipants, isHost, selfName, isMuted, handRaised, raisedHandCount, isRecording, activeReactions, whiteboard }: NativeMeetingStageProps): React.JSX.Element {
  const selfAvatarRecipe = useMemo(() => getParticipantAvatarRecipe(selfName), [selfName]);
  const verticalStrip = !isCompactViewport && layoutMode === "speaker";

  let primaryStage: React.JSX.Element;
  if (primaryContent === "whiteboard") {
    primaryStage = <NativeWhiteboardPlaceholder whiteboard={whiteboard} />;
  } else if (primaryContent === "screen-share-placeholder") {
    primaryStage = <NativeLocalSharePlaceholder screenSharer={screenSharer} />;
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
            <View style={styles.selfIndicator}>
              <HugeiconsIcon color="#ffffff" icon={WavingHand01Icon} size={10} />
            </View>
          ) : null}
          {isMuted ? (
            <View style={styles.selfIndicatorMuted}>
              <HugeiconsIcon color="#ffffff" icon={MicOff01Icon} size={10} />
            </View>
          ) : null}
        </View>
      </View>

      {stripParticipants.length > 0 ? (
        <View style={[styles.stripShell, verticalStrip ? styles.stripShellVertical : styles.stripShellHorizontal]}>
          <View style={styles.stripHeader}>
            <HugeiconsIcon color={Theme.colors.primary} icon={UserGroupIcon} size={16} />
            <Text style={styles.stripTitle}>Participants</Text>
          </View>
          <NativeParticipantStrip participants={stripParticipants} vertical={verticalStrip} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    gap: Theme.spacing.sm,
  },
  containerVertical: {
    flexDirection: "row",
  },
  primaryFrame: {
    flex: 1,
    minHeight: 0,
  },
  surface: {
    flex: 1,
    borderRadius: Theme.radius["2xl"],
    overflow: "hidden",
    backgroundColor: Theme.colors.stageBackground,
  },
  splitStage: {
    flex: 1,
    flexDirection: "row",
    gap: Theme.spacing.sm,
  },
  splitPanel: {
    flex: 1,
  },
  placeholderCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Theme.spacing["3xl"],
    gap: Theme.spacing.md,
  },
  placeholderIconCircle: {
    width: 68,
    height: 68,
    borderRadius: Theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.12)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
  },
  placeholderEyebrow: {
    ...Theme.typography.eyebrow,
    color: Theme.colors.primaryForeground,
  },
  placeholderTitle: {
    ...Theme.typography.heading,
    color: Theme.colors.foreground,
    textAlign: "center",
  },
  placeholderCopy: {
    ...Theme.typography.body,
    color: "rgba(255,255,255,0.78)",
    textAlign: "center",
  },
  infoChip: {
    position: "absolute",
    top: Theme.spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: Theme.spacing.sm,
    paddingHorizontal: Theme.spacing.md,
    paddingVertical: Theme.spacing.sm,
    borderRadius: Theme.radius.full,
    backgroundColor: "rgba(12,17,27,0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  infoChipLeft: {
    left: Theme.spacing.md,
  },
  infoChipRight: {
    right: Theme.spacing.md,
  },
  infoChipText: {
    color: Theme.colors.foreground,
    fontSize: 12,
    fontWeight: "700",
  },
  reactionRail: {
    position: "absolute",
    left: Theme.spacing.md,
    right: Theme.spacing.md,
    bottom: Theme.spacing["4xl"],
    flexDirection: "row",
    gap: Theme.spacing.sm,
  },
  reactionBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: Theme.spacing.sm,
    borderRadius: Theme.radius.full,
    backgroundColor: "rgba(12,17,27,0.78)",
    paddingHorizontal: Theme.spacing.md,
    paddingVertical: Theme.spacing.sm,
  },
  reactionEmoji: {
    fontSize: 16,
  },
  reactionName: {
    color: Theme.colors.foreground,
    fontSize: 12,
    fontWeight: "700",
    maxWidth: 110,
  },
  selfPill: {
    position: "absolute",
    left: Theme.spacing.md,
    bottom: Theme.spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: Theme.spacing.sm,
    paddingHorizontal: Theme.spacing.md,
    paddingVertical: Theme.spacing.sm,
    borderRadius: Theme.radius.full,
    backgroundColor: "rgba(12,17,27,0.82)",
  },
  selfAvatar: {
    width: 28,
    height: 28,
    borderRadius: Theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  selfAvatarText: {
    color: Theme.colors.primaryForeground,
    fontSize: 11,
    fontWeight: "800",
  },
  selfPillName: {
    color: Theme.colors.foreground,
    fontSize: 12,
    fontWeight: "700",
  },
  selfIndicator: {
    width: 18,
    height: 18,
    borderRadius: Theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(245, 158, 11, 0.88)",
  },
  selfIndicatorMuted: {
    width: 18,
    height: 18,
    borderRadius: Theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(239, 68, 68, 0.88)",
  },
  stripShell: {
    borderRadius: Theme.radius["2xl"],
    backgroundColor: Theme.colors.card,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    overflow: "hidden",
  },
  stripShellHorizontal: {
    height: 146,
  },
  stripShellVertical: {
    width: 148,
  },
  stripHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: Theme.spacing.sm,
    paddingHorizontal: Theme.spacing.md,
    paddingTop: Theme.spacing.md,
  },
  stripTitle: {
    color: Theme.colors.foreground,
    fontSize: 13,
    fontWeight: "700",
  },
  stripContent: {
    gap: Theme.spacing.sm,
    padding: Theme.spacing.md,
  },
  stripHorizontal: {
    flexDirection: "row",
  },
  stripVertical: {
    flexDirection: "column",
  },
  stripTile: {
    overflow: "hidden",
  },
  stripTileHorizontal: {
    width: 168,
    height: 92,
  },
  stripTileVertical: {
    width: "100%",
    height: 92,
  },
});
