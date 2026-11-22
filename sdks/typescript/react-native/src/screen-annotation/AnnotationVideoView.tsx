import type { MediaStreamTrack as NativeTrack } from "@cloudflare/react-native-webrtc";
import { Platform, requireNativeComponent, UIManager, type NativeSyntheticEvent, type ViewProps } from "react-native";
import { RtcVideoView } from "../components/RtcVideoView";
import type { PresentedAnnotationFrame } from "../components/rtc-video-view-availability";

type NativeProps = ViewProps & {
  readonly trackId: string;
  readonly peerConnectionId: number;
  readonly sampleFrames: boolean;
  readonly onAnnotationFrame?: (event: NativeSyntheticEvent<PresentedAnnotationFrame>) => void;
};

const viewName = "ChalkAnnotationVideoView";
const AnnotationSurface = Platform.OS === "android" && UIManager.getViewManagerConfig(viewName) ? requireNativeComponent<NativeProps>(viewName) : null;

export function AnnotationVideoView({
  track,
  streamURL,
  style,
  onPresented,
}: ViewProps & {
  readonly track: MediaStreamTrack;
  readonly streamURL: string;
  readonly onPresented?: (frame: PresentedAnnotationFrame) => void;
}): React.JSX.Element {
  const native = track as unknown as NativeTrack;
  if (!AnnotationSurface || !native.remote || !Number.isInteger(native._peerConnectionId)) {
    // iOS's public RTCVideoRenderer callback runs before RTCMTLVideoView presents. Without
    // a presentation witness, do not retire ink on decode; use the pending ink's expiry.
    return <RtcVideoView objectFit="contain" streamURL={streamURL} style={style} />;
  }
  return <AnnotationSurface trackId={track.id} peerConnectionId={native._peerConnectionId} sampleFrames={Boolean(onPresented)} onAnnotationFrame={onPresented && ((event) => onPresented(event.nativeEvent))} style={style} />;
}
