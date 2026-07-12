import { RTCView } from "../media/realtimekit/native-webrtc";
import { canRenderNativeRtcVideoView, type NativeRtcVideoViewProps } from "./native-rtc-video-view-availability";

export function hasNativeRtcVideoView(): boolean {
  return canRenderNativeRtcVideoView(RTCView);
}

export function NativeRtcVideoView(props: NativeRtcVideoViewProps): React.JSX.Element | null {
  if (!canRenderNativeRtcVideoView(RTCView)) {
    return null;
  }

  const NativeRtcView = RTCView;
  return <NativeRtcView {...props} />;
}
