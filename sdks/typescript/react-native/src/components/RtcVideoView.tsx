import { RTCView } from "../media/native-webrtc";
import { canRenderRtcVideoView, type RtcVideoViewProps } from "./rtc-video-view-availability";

export function hasRtcVideoView(): boolean {
  return canRenderRtcVideoView(RTCView);
}

export function RtcVideoView(props: RtcVideoViewProps): React.JSX.Element | null {
  if (!canRenderRtcVideoView(RTCView)) {
    return null;
  }

  const RtcView = RTCView;
  return <RtcView {...props} />;
}
