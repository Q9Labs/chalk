import { MediaStream, type MediaStreamTrack as NativeMediaStreamTrack, RTCView } from "@cloudflare/react-native-webrtc";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import type { Participant } from "@q9labs/chalk-core";
import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Theme } from "../ui/theme";
import { shouldRenderNativeMediaTrack } from "./native-media-visibility";
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
  const shouldRenderVideo = shouldRenderNativeMediaTrack({ participant, track });
  const stream = useMemo(() => {
    if (!shouldRenderVideo || !track) {
      return null;
    }

    return new MediaStream([track as NativeMediaStreamTrack]);
  }, [shouldRenderVideo, track]);

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
            <HugeiconsIcon icon={MicOff01Icon} size={12} color="#ffffff" />
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
    left: Theme.spacing.sm,
    right: Theme.spacing.sm,
    bottom: Theme.spacing.sm,
    flexDirection: "row",
    gap: 4,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: Theme.radius.full,
    backgroundColor: "rgba(0,0,0,0.58)",
  },
  mutedBadge: {
    backgroundColor: "rgba(239, 68, 68, 0.85)",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  badgeText: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "700",
  },
});
