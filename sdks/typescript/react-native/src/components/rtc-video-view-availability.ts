import type { ComponentType } from "react";
import type { StyleProp, ViewProps, ViewStyle } from "react-native";

export interface RtcVideoViewProps extends ViewProps {
  streamURL: string;
  mirror?: boolean;
  objectFit?: "cover" | "contain";
  zOrder?: number;
  style?: StyleProp<ViewStyle>;
}

type RtcVideoViewComponent = ComponentType<RtcVideoViewProps>;

export function canRenderRtcVideoView(component: unknown): component is RtcVideoViewComponent {
  return typeof component === "function" || (typeof component === "object" && component !== null);
}
