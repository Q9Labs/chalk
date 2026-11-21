import type { ScreenAnnotationCommand } from "@q9labsai/chalk-client";
import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useDeviceLayout } from "../frame/device-layout";
import { Portal } from "../frame/portal";
import { frameRegions } from "../frame/regions";
import { useToasts } from "../primitives/toast/ToastStack";
import { ToolButton } from "./ScreenAnnotationToolbar";
import { hasTarget, matchLayer, targetFor, type StageAnnotation } from "./model";

export function AnnotationDock({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const { arrangement, width, height, insets } = useDeviceLayout();
  const dock = frameRegions(arrangement, width, height, insets).dock;
  return <Portal layer="annotation">
    <View pointerEvents="box-none" style={[styles.dock, { bottom: height - dock.y + 8, left: insets.left + 8, right: insets.right + 8 }]}>
      {children}
    </View>
  </Portal>;
}

/** MediaProjection may capture Chalk itself. Without exclusion proof, expose controls but no ink. */
export function AndroidShareAnnotationControls({ annotation, publicationId, participantId }: {
  readonly annotation: StageAnnotation;
  readonly publicationId: string;
  readonly participantId: string;
}): React.JSX.Element | null {
  const { client } = annotation;
  const toasts = useToasts();
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const get = useCallback(() => matchLayer(client, publicationId), [client, publicationId]);
  const state = useSyncExternalStore(subscribe, get, get);
  if (!state?.access.can_moderate || state.layer.sharer_id !== participantId ||
      (annotation.publicationId && annotation.publicationId !== publicationId)) return null;

  const target = targetFor(state);
  const run = async (command: ScreenAnnotationCommand) => {
    if (!hasTarget(get(), target)) return;
    try {
      const result = await client.dispatch(target, command);
      if (result.kind === "accepted" || (result.kind === "rejected" && result.reason === "stale_fence")) return;
    } catch {
      // Network and bounded rejections use the same actionable feedback.
    }
    toasts.show({ kind: "error", dismissible: true, message: "Couldn’t confirm the mark action." });
  };

  return <AnnotationDock>
    <View style={styles.controls}>
      <ToolButton label={state.paused ? "Resume marks" : "Pause marks"} onPress={() => void run({ kind: "pause", paused: !state.paused })} />
      <ToolButton label="Clear all marks" onPress={() => void run({ kind: "clear", scope: { kind: "all" } })} />
    </View>
  </AnnotationDock>;
}

const styles = StyleSheet.create({
  dock: { position: "absolute", maxHeight: "50%", alignItems: "center" },
  controls: { width: "100%", maxWidth: 320, flexDirection: "row", gap: 4 },
});
