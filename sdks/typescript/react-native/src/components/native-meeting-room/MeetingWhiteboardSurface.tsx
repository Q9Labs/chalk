import { useCallback } from "react";
import { StyleSheet } from "react-native";

import { ChalkEmbeddedWhiteboard } from "../ChalkEmbeddedWhiteboard";
import type { WhiteboardMetric } from "../../telemetry";
import type { MeetingWhiteboardState } from "./useConferenceViewPanels";

export interface MeetingWhiteboardSurfaceProps {
  readonly whiteboard: MeetingWhiteboardState;
}

export function shouldRenderNativeMeetingWhiteboard(whiteboard: MeetingWhiteboardState): whiteboard is MeetingWhiteboardState & {
  readonly transport: NonNullable<MeetingWhiteboardState["transport"]>;
} {
  return whiteboard.isOpen && whiteboard.transport !== null;
}

export function forwardNativeMeetingWhiteboardMetric(metric: WhiteboardMetric, onMetric: MeetingWhiteboardState["onMetric"]): void {
  onMetric?.(metric);
}

export function MeetingWhiteboardSurface({ whiteboard }: MeetingWhiteboardSurfaceProps): React.JSX.Element | null {
  const handleError = useCallback(
    (error: { readonly code: string; readonly message: string; readonly recoverable: boolean }) => {
      console.warn("[chalk][embedded-whiteboard] renderer failure", {
        journeyId: whiteboard.journeyId,
        code: error.code,
        recoverable: error.recoverable,
        message: error.message,
      });
    },
    [whiteboard.journeyId],
  );
  const handleMetric = useCallback(
    (metric: WhiteboardMetric) => {
      forwardNativeMeetingWhiteboardMetric(metric, whiteboard.onMetric);
      if (typeof __DEV__ === "undefined" || !__DEV__) return;
      console.info("[chalk][embedded-whiteboard] renderer metric", {
        journeyId: whiteboard.journeyId,
        name: metric.name,
        value: metric.value,
        attributes: metric.attributes,
      });
    },
    [whiteboard.journeyId, whiteboard.onMetric],
  );

  if (!shouldRenderNativeMeetingWhiteboard(whiteboard)) return null;

  return (
    <ChalkEmbeddedWhiteboard
      canClear={whiteboard.canClear}
      canDraw={whiteboard.canDraw}
      journeyId={whiteboard.journeyId}
      onError={handleError}
      onMetric={handleMetric}
      style={styles.surface}
      theme="dark"
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
