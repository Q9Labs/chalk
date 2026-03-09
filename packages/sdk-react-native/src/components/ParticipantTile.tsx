/**
 * ParticipantTile - Renders a participant's video or avatar
 * For use in video grids showing remote participants
 */

import { useMemo } from "react";
import { View, Text, StyleSheet, type ViewStyle } from "react-native";
import type { Participant } from "@q9labs/chalk-core";
import { CHALK_THEME } from "../theme";
import { VideoView } from "./VideoView";
import { MutedIcon } from "../icons";

interface ParticipantTileProps {
  /** Participant data including video/audio tracks */
  participant: Participant;
  /** Mirror video (for local camera) */
  mirror?: boolean;
  /** Show name label */
  showName?: boolean;
  /** Container style */
  style?: ViewStyle;
}

// Dynamic require for MediaStream constructor (not available as type-only import)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let MediaStreamClass: { new (tracks?: unknown[]): any } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  MediaStreamClass = require("@cloudflare/react-native-webrtc").MediaStream;
} catch {
  // Native module not available
}

/**
 * Creates a MediaStream from a track for rendering
 */
function createStreamFromTrack(track: unknown): MediaStream | null {
  if (!track || !MediaStreamClass) return null;
  try {
    // In react-native-webrtc, we need to create a MediaStream from the track
    const stream = new MediaStreamClass();
    stream.addTrack(track);
    return stream as MediaStream;
  } catch {
    return null;
  }
}

export function ParticipantTile({ participant, mirror = false, showName = true, style }: ParticipantTileProps) {
  const { displayName, videoEnabled, videoTrack, audioEnabled, isLocal } = participant;

  // Create stream from video track
  const videoStream = useMemo(() => (videoEnabled ? createStreamFromTrack(videoTrack) : null), [videoEnabled, videoTrack]);

  const initials = displayName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <View style={[styles.container, style]}>
      {videoStream ? (
        <VideoView stream={videoStream} mirror={mirror || isLocal} objectFit="cover" style={styles.video} />
      ) : (
        <View style={styles.avatarContainer}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
        </View>
      )}

      {/* Mute indicator */}
      {!audioEnabled && (
        <View style={styles.muteIndicator}>
          <MutedIcon size={12} color={CHALK_THEME.colors.text.primary} />
        </View>
      )}

      {/* Name label */}
      {showName && (
        <View style={styles.nameContainer}>
          <Text style={styles.nameText} numberOfLines={1}>
            {displayName}
            {isLocal && " (You)"}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    borderRadius: CHALK_THEME.borderRadius.lg,
    overflow: "hidden",
    backgroundColor: CHALK_THEME.colors.surface,
    position: "relative",
  },
  video: {
    flex: 1,
    backgroundColor: "#000",
  },
  avatarContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: CHALK_THEME.colors.surfaceHighlight,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: CHALK_THEME.colors.ui.pillBg,
    justifyContent: "center",
    alignItems: "center",
  },
  avatarText: {
    color: CHALK_THEME.colors.text.primary,
    fontSize: CHALK_THEME.typography.sizes.xl,
    fontWeight: "600",
  },
  muteIndicator: {
    position: "absolute",
    top: CHALK_THEME.spacing.sm,
    right: CHALK_THEME.spacing.sm,
    backgroundColor: CHALK_THEME.colors.ui.overlay,
    borderRadius: CHALK_THEME.borderRadius.lg,
    padding: CHALK_THEME.spacing.xs,
  },
  nameContainer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: CHALK_THEME.colors.ui.overlay,
    paddingHorizontal: CHALK_THEME.spacing.sm,
    paddingVertical: CHALK_THEME.spacing.xs,
  },
  nameText: {
    color: CHALK_THEME.colors.text.primary,
    fontSize: CHALK_THEME.typography.sizes.xs,
    fontWeight: "500",
  },
});
