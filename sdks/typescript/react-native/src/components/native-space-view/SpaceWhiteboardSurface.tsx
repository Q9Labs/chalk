import { StyleSheet } from "react-native";
import { EmbeddedWhiteboard } from "../EmbeddedWhiteboard";
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
export function SpaceWhiteboardSurface({ whiteboard }: SpaceWhiteboardSurfaceProps): React.JSX.Element | null {
  const nativeTheme = useNativeTheme();
  if (!shouldRenderNativeSpaceWhiteboard(whiteboard)) return null;
  return (
    <EmbeddedWhiteboard
      canClear={whiteboard.canClear}
      canDraw={whiteboard.canDraw}
      journeyId={whiteboard.journeyId}
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
