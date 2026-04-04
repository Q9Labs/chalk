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
  mediaKind?: "camera" | "screen-share";
  label?: string;
  mirror?: boolean;
  objectFit?: "cover" | "contain";
  emphasizeMuted?: boolean;
  zOrder?: number;
}

export function NativeMediaView({ participant, track, mediaKind = "camera", label, mirror = false, objectFit = "cover", emphasizeMuted = false, zOrder = 0 }: NativeMediaViewProps): React.JSX.Element {
  const shouldRenderVideo = shouldRenderNativeMediaTrack({ participant, track, mediaKind });
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
          <NativeGradientSurface borderRadius={0} opacity={0.92} participantId={name} />
          <NativeFaceAvatar name={name} size={88} textSize={34} />
        </View>
      ) : null}

      <View style={styles.badgeRow}>
        <View style={styles.integratedBadge}>
          <Text style={styles.badgeText} numberOfLines={1}>
            {label || name}
          </Text>
          {isMuted ? (
            <View style={styles.muteIndicator}>
              <HugeiconsIcon icon={MicOff01Icon} size={10} color="#ffffff" />
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  surface: {
    flex: 1,
    minHeight: 80,
    width: "100%",
    height: "100%",
    overflow: "hidden",
    backgroundColor: Theme.colors.stageBackground,
    borderRadius: 24,
    position: "relative",
  },
  fallback: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "100%",
  },
  badgeRow: {
    position: "absolute",
    left: 10,
    bottom: 10,
    flexDirection: "row",
  },
  integratedBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    gap: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  badgeText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
    maxWidth: 100,
  },
  muteIndicator: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#ea4335",
    alignItems: "center",
    justifyContent: "center",
  },
});
