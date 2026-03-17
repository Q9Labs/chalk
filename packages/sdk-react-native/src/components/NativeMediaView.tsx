import type { Participant } from "@q9labs/chalk-core";
import { MediaStream, RTCView, type MediaStreamTrack as NativeMediaStreamTrack } from "@cloudflare/react-native-webrtc";
import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Theme } from "../ui/theme";
import { NativeFaceAvatar } from "./NativeFaceAvatar";
import { NativeGradientSurface } from "./NativeGradientSurface";

interface NativeMediaViewProps {
  participant: Participant | null;
  track: MediaStreamTrack | NativeMediaStreamTrack | null | undefined;
  label?: string;
  mirror?: boolean;
  objectFit?: "cover" | "contain";
  emphasizeMuted?: boolean;
  zOrder?: number;
}

export function NativeMediaView({ participant, track, label, mirror = false, objectFit = "cover", emphasizeMuted = false, zOrder = 0 }: NativeMediaViewProps): React.JSX.Element {
  const stream = useMemo(() => {
    if (!track) {
      return null;
    }

    return new MediaStream([track as NativeMediaStreamTrack]);
  }, [track]);

  const name = participant?.displayName?.trim() || label || "Participant";
  const isMuted = emphasizeMuted && participant ? !participant.audioEnabled : false;

  return (
    <View style={styles.surface}>
      {stream ? <RTCView mirror={mirror} objectFit={objectFit} streamURL={stream.toURL()} style={StyleSheet.absoluteFillObject} zOrder={Math.max(1, zOrder)} /> : null}

      {!stream ? (
        <View style={styles.fallback}>
          <NativeGradientSurface borderRadius={Theme.radius.xl} opacity={0.92} participantId={name} />
          <NativeFaceAvatar name={name} size={88} textSize={34} />
        </View>
      ) : null}

      <View style={styles.badgeRow}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{label || name}</Text>
        </View>
        {isMuted ? (
          <View style={[styles.badge, styles.mutedBadge]}>
            <Text style={styles.badgeText}>Muted</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  surface: {
    flex: 1,
    minHeight: 80,
    overflow: "hidden",
    borderRadius: Theme.radius.xl,
    backgroundColor: Theme.colors.stageBackground,
  },
  fallback: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeRow: {
    position: "absolute",
    left: Theme.spacing.md,
    right: Theme.spacing.md,
    bottom: Theme.spacing.md,
    flexDirection: "row",
    gap: Theme.spacing.sm,
  },
  badge: {
    paddingHorizontal: Theme.spacing.md,
    paddingVertical: Theme.spacing.sm,
    borderRadius: Theme.radius.full,
    backgroundColor: "rgba(0,0,0,0.68)",
  },
  mutedBadge: {
    backgroundColor: "rgba(239, 68, 68, 0.88)",
  },
  badgeText: {
    color: Theme.colors.foreground,
    fontSize: 12,
    fontWeight: "700",
  },
});
