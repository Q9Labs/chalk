import type { ComponentType } from "react";
import { RTCView } from "@cloudflare/react-native-webrtc";
import { canRenderNativeRtcVideoView, type NativeRtcVideoViewProps } from "./native-rtc-video-view-availability";

export function hasNativeRtcVideoView(): boolean {
  return canRenderNativeRtcVideoView(RTCView);
}

export function NativeRtcVideoView(props: NativeRtcVideoViewProps): React.JSX.Element | null {
  if (!canRenderNativeRtcVideoView(RTCView)) {
    return null;
  }

  const PreviewVideo = RTCView as unknown as ComponentType<NativeRtcVideoViewProps>;
  return <PreviewVideo {...props} />;
}
