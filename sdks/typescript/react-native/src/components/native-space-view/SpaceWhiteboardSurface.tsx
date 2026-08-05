import { useCallback } from "react";
import { StyleSheet } from "react-native";

import { EmbeddedWhiteboard } from "../EmbeddedWhiteboard";
import type { WhiteboardMetric } from "../../telemetry";
import { useNativeTheme } from "../../ui/native-theme";
import type { SpaceWhiteboardState } from "./useSpaceViewPanels";

export interface SpaceWhiteboardSurfaceProps {
  readonly whiteboard: SpaceWhiteboardState;
}

export function shouldRenderNativeSpaceWhiteboard(whiteboard: SpaceWhiteboardState): whiteboard is SpaceWhiteboardState & {
  readonly transport: NonNullable<SpaceWhiteboardState["transport"]>;
} {
  return whiteboard.isOpen && whiteboard.transport !== null;
}

export function forwardNativeSpaceWhiteboardMetric(metric: WhiteboardMetric, onMetric: SpaceWhiteboardState["onMetric"]): void {
  onMetric?.(metric);
}

export function forwardNativeSpaceWhiteboardFailure(error: { readonly code: string; readonly recoverable: boolean }, onMetric: SpaceWhiteboardState["onMetric"]): void {
  onMetric?.({
    name: "whiteboard.renderer.failure",
    value: 1,
    attributes: { code: error.code, recoverable: error.recoverable },
  });
}

export function SpaceWhiteboardSurface({ whiteboard }: SpaceWhiteboardSurfaceProps): React.JSX.Element | null {
  const nativeTheme = useNativeTheme();
  const handleError = useCallback(
    (error: { readonly code: string; readonly message: string; readonly recoverable: boolean }) => {
      forwardNativeSpaceWhiteboardFailure(error, whiteboard.onMetric);
    },
    [whiteboard.onMetric],
  );
  const handleMetric = useCallback(
    (metric: WhiteboardMetric) => {
      forwardNativeSpaceWhiteboardMetric(metric, whiteboard.onMetric);
    },
    [whiteboard.onMetric],
  );

  if (!shouldRenderNativeSpaceWhiteboard(whiteboard)) return null;

  return (
    <EmbeddedWhiteboard
      canClear={whiteboard.canClear}
      canDraw={whiteboard.canDraw}
      journeyId={whiteboard.journeyId}
      onError={handleError}
      onMetric={handleMetric}
      style={styles.surface}
      theme={nativeTheme.colorScheme}
      transport={whiteboard.transport}
      {...(whiteboard.traceparent ? { traceparent: whiteboard.traceparent } : {})}
      {...(whiteboard.tracestate ? { tracestate: whiteboard.tracestate } : {})}
    />
  );
}

const styles = StyleSheet.create({
  surface: {
    flex: 1,
    width: "100%",
  },
});
