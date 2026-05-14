import type { ComponentType } from "react";
import type { StyleProp, ViewProps, ViewStyle } from "react-native";

export interface NativeRtcVideoViewProps extends ViewProps {
  streamURL: string;
  mirror?: boolean;
  objectFit?: "cover" | "contain";
  zOrder?: number;
  style?: StyleProp<ViewStyle>;
}

type NativeRtcVideoViewComponent = ComponentType<NativeRtcVideoViewProps>;

export function canRenderNativeRtcVideoView(component: unknown): component is NativeRtcVideoViewComponent {
  return typeof component === "function" || (typeof component === "object" && component !== null);
}
