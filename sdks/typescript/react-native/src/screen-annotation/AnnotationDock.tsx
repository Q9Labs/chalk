import { space } from "../theme/tokens";
import type { ScreenAnnotationCommand, SpaceSnapshot } from "@q9labsai/chalk-client";
import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform, ScrollView, StyleSheet, View } from "react-native";
import { useDeviceLayout } from "../frame/device-layout";
import { Portal } from "../frame/portal";
import { frameRegions } from "../frame/regions";
import { useToasts } from "../primitives/toast/ToastStack";
import { useSpaceSelector } from "../stage/space-selector";
import { useTheme } from "../theme/theme";
import { ShareAnnotationPiP } from "./ShareAnnotationPiP";
import { ManageMarks, ToolButton } from "./ScreenAnnotationToolbar";
import { hasTarget, matchLayer, targetFor, type StageAnnotation } from "./model";

const selectRoster = (snapshot: SpaceSnapshot) => snapshot.participants.roster;
const selectAccess = (snapshot: SpaceSnapshot) => snapshot.whiteboard.access;

export function useAnnotationPeople(participantId: string) {
  const roster = useSpaceSelector(selectRoster);
  const access = useSpaceSelector(selectAccess);
  return roster
    .filter((person) => person.participantId !== participantId)
    .map((person) => ({
      id: person.participantId,
      name: person.displayName,
      manages: person.capabilities.includes("manageWhiteboard"),
      canDraw: access.permissions.find((permission) => permission.participantId === person.participantId)?.canDraw ?? (access.policy === "everyone" && person.capabilities.includes("drawWhiteboard")),
    }));
}

export function AnnotationDock({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const { arrangement, width, height, insets } = useDeviceLayout();
  const dock = frameRegions(arrangement, width, height, insets).dock;
  return (
    <Portal layer="annotation">
      <View pointerEvents="box-none" style={[styles.dock, { bottom: height - dock.y + 8, left: insets.left + 8, right: insets.right + 8 }]}>
        {children}
      </View>
    </Portal>
  );
}

/** Controls live in Chalk, not in the system ink window. */
export function ShareAnnotationControls({
  annotation,
  publicationId,
  participantId,
  people,
  trackId,
}: {
  readonly annotation: StageAnnotation;
  readonly publicationId: string;
  readonly participantId: string;
  readonly people: ReturnType<typeof useAnnotationPeople>;
  readonly trackId?: string;
}): React.JSX.Element | null {
  const { client } = annotation;
  const toasts = useToasts();
  const { colors } = useTheme();
  const [showPolicy, setShowPolicy] = useState(false);
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const get = useCallback(() => matchLayer(client, publicationId), [client, publicationId]);
  const state = useSyncExternalStore(subscribe, get, get);
  if (!state?.access.can_moderate || state.layer.sharer_id !== participantId || (annotation.publicationId && annotation.publicationId !== publicationId)) return null;

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

  return (
    <AnnotationDock>
      {Platform.OS === "ios" && !state.layer.burned_in ? <ShareAnnotationPiP key={state.layer.layer_id} client={client} layer={state.layer} trackId={trackId} /> : null}
      <View style={styles.controls}>
        <ToolButton label={state.paused ? "Resume marks" : "Pause marks"} onPress={() => void run({ kind: "pause", paused: !state.paused })} />
        <ToolButton label="Clear all marks" onPress={() => void run({ kind: "clear", scope: { kind: "all" } })} />
        {state.access.can_manage_policy ? <ToolButton label="Who can draw" selected={showPolicy} onPress={() => setShowPolicy(!showPolicy)} /> : null}
      </View>
      {showPolicy && state.access.can_manage_policy ? (
        <ScrollView style={[styles.policy, { backgroundColor: colors.canvas }]} contentContainerStyle={styles.policyContent}>
          <ManageMarks state={state} people={people} nowMs={client.serverNowMs()} onCommand={(command) => void run(command)} showPauseAndClear={false} />
        </ScrollView>
      ) : null}
    </AnnotationDock>
  );
}

const styles = StyleSheet.create({
  dock: { position: "absolute", maxHeight: "50%", alignItems: "center" },
  controls: { width: "100%", maxWidth: 320, flexDirection: "row", gap: space[1] },
  policy: { width: "100%", maxWidth: 320, flexShrink: 1 },
  policyContent: { padding: space[2], gap: space[1] },
});
