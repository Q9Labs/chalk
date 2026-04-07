import { MediaStream, type MediaStreamTrack as NativeMediaStreamTrack, RTCView } from "@cloudflare/react-native-webrtc";
import type { Participant } from "@q9labs/chalk-core";
import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
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

export function NativeMediaView({ participant, track, mediaKind = "camera", label, mirror = false, objectFit = "cover", zOrder = 0 }: NativeMediaViewProps): React.JSX.Element {
  const shouldRenderVideo = shouldRenderNativeMediaTrack({ participant, track, mediaKind });
  const stream = useMemo(() => {
    if (!shouldRenderVideo || !track) {
      return null;
    }

    return new MediaStream([track as NativeMediaStreamTrack]);
  }, [shouldRenderVideo, track]);

  const name = participant?.displayName?.trim() || label || "Participant";

  return (
    <View style={styles.surface}>
      {stream ? <RTCView mirror={mirror} objectFit={objectFit} streamURL={stream.toURL()} style={StyleSheet.absoluteFillObject} zOrder={Math.max(1, zOrder)} /> : null}

      {!stream ? (
        <View style={styles.fallback}>
          <NativeGradientSurface borderRadius={0} opacity={0.92} participantId={name} />
          <NativeFaceAvatar name={name} size={88} textSize={34} />
        </View>
      ) : null}


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
});
