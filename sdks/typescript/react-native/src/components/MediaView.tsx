import type { NativeParticipant as Participant } from "../ui/native-types";
import { createNativeMediaStream, type NativeMediaStreamTrack } from "../media/native-webrtc";
import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { Theme } from "../ui/theme";
import { useNativeTheme } from "../ui/native-theme";
import { shouldRenderNativeMediaTrack } from "./native-media-visibility";
import { FaceAvatar } from "./FaceAvatar";
import { GradientSurface } from "./GradientSurface";
import { hasRtcVideoView, RtcVideoView } from "./RtcVideoView";

export interface MediaViewProps {
  participant: Participant | null;
  track: MediaStreamTrack | NativeMediaStreamTrack | null | undefined;
  mediaKind?: "camera" | "screen-share";
  label?: string;
  mirror?: boolean;
  objectFit?: "cover" | "contain";
  emphasizeMuted?: boolean;
  zOrder?: number;
}

export function MediaView({ participant, track, mediaKind = "camera", label, mirror = false, objectFit = "cover", zOrder = 0 }: MediaViewProps): React.JSX.Element {
  const theme = useNativeTheme();
  const shouldRenderVideo = shouldRenderNativeMediaTrack({ participant, track, mediaKind });
  const canRenderPreview = hasRtcVideoView();
  const stream = useMemo(() => {
    if (!shouldRenderVideo || !track) {
      return null;
    }

    return createNativeMediaStream(track);
  }, [shouldRenderVideo, track]);

  const name = participant?.displayName?.trim() || label || "Participant";
  const showStream = Boolean(stream && canRenderPreview);
  const streamURL = showStream && stream ? stream.toURL() : null;

  return (
    <View style={[styles.surface, { backgroundColor: theme.colors.stageBackground }]}>
      {streamURL ? <RtcVideoView mirror={mirror} objectFit={objectFit} streamURL={streamURL} style={StyleSheet.absoluteFillObject} zOrder={Math.max(1, zOrder)} /> : null}

      {!showStream ? (
        <View style={styles.fallback}>
          <GradientSurface borderRadius={0} opacity={0.92} participantId={name} />
          <FaceAvatar name={name} size={88} textSize={34} />
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
    borderRadius: Theme.radius.md,
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
