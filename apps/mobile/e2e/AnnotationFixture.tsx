import { corners, fixed, fontSizes, palettes, space, type as callType } from "../../../sdks/typescript/react-native/src/theme/tokens";
import type { ScreenAnnotationClient, ScreenAnnotationMark, ScreenAnnotationSnapshot, ScreenAnnotationState } from "@q9labsai/chalk-client";
import { annotationRendererUrl } from "@q9labsai/chalk-react-native/dev";
import { ScreenAnnotationLayer } from "@q9labsai/chalk-react-native/ui";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { DeviceLayoutProvider } from "../../../sdks/typescript/react-native/src/frame/device-layout";
import { Portal, PortalHost, PortalProvider } from "../../../sdks/typescript/react-native/src/frame/portal";
import { ToastProvider } from "../../../sdks/typescript/react-native/src/primitives/toast/ToastStack";
import { ShareAnnotationControls } from "../../../sdks/typescript/react-native/src/screen-annotation/AnnotationDock";

const publicationId = "fixture-screen";
const sharerId = "a35a71ce-912f-4c14-a283-dd2eaa6490e8";
const viewer = { id: "b14632b1-1636-4024-9dfb-5626ef134337", name: "Omar" };
const size = { width: 1600, height: 1000 };
const initial: ScreenAnnotationState = {
  layer: { layer_id: "e5d09f9b-adb6-4f3f-be3d-d823f7be59fd", sharer_id: sharerId, publication_id: publicationId, frame: size },
  fence: 1,
  revision: 1,
  paused: false,
  access: { can_draw: true, draw_policy: "everyone", default_color: "#67ddaa", can_moderate: false, can_manage_policy: false, requests: [] },
  marks: [],
};

function createFixture() {
  let state = initial;
  let undo: (readonly ScreenAnnotationMark[])[] = [];
  let redo: (readonly ScreenAnnotationMark[])[] = [];
  let snapshot: ScreenAnnotationSnapshot = { status: "ready", state, presence: [] };
  const listeners = new Set<() => void>();
  function update(next: Partial<ScreenAnnotationState>) {
    state = { ...state, revision: state.revision + 1, ...next };
    snapshot = { status: "ready", state, presence: [] };
    for (const notify of listeners) notify();
  }
  const client: ScreenAnnotationClient = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    serverNowMs: Date.now,
    setPresence: () => undefined,
    async dispatch(target, command) {
      if (target.fence !== state.fence) return { kind: "rejected", reason: "stale_fence" };
      if (command.kind === "commit") {
        const now = Date.now();
        if (command.draft.lifetime === "keep") {
          undo.push(state.marks);
          redo = [];
        }
        update({
          marks: [
            ...state.marks,
            {
              draft: command.draft,
              author: { participant_id: viewer.id, display_name: viewer.name, color: initial.access.default_color },
              created_revision: state.revision + 1,
              committed_at_ms: now,
              expires_at_ms: command.draft.lifetime === "fade" ? now + 2000 : null,
            },
          ],
        });
      }
      if (command.kind === "erase") update({ marks: state.marks.filter(({ draft }) => draft.mark_id !== command.mark_id) });
      if (command.kind === "undo" && undo.length) {
        redo.push(state.marks);
        update({ marks: undo.pop() ?? [] });
      }
      if (command.kind === "redo" && redo.length) {
        undo.push(state.marks);
        update({ marks: redo.pop() ?? [] });
      }
      if (command.kind === "clear") {
        undo = [];
        redo = [];
        update({ fence: state.fence + 1, marks: [] });
      }
      if (command.kind === "pause") update({ paused: command.paused, fence: state.fence + 1 });
      if (command.kind === "request_draw")
        update({
          access: { ...state.access, requests: [{ request_id: "test-request", participant_id: viewer.id, expires_at_ms: Date.now() + 30_000 }] },
        });
      return { kind: "accepted", revision: state.revision, layer_id: state.layer.layer_id };
    },
  };
  return {
    client,
    count: () => state.marks.length,
    pause: () => update({ paused: !state.paused, fence: state.fence + 1 }),
    access: () => update({ access: { ...state.access, can_draw: !state.access.can_draw, requests: [] }, fence: state.fence + 1 }),
    receiveViewerMark: () =>
      client.dispatch(
        { layerId: state.layer.layer_id, fence: state.fence },
        {
          kind: "commit",
          draft: {
            mark_id: "background-viewer-mark",
            color: initial.access.default_color,
            width: 800,
            lifetime: "keep",
            shape: { kind: "arrow", from_point: { x: 11000, y: 17000 }, to_point: { x: 50000, y: 40000 } },
          },
        },
      ),
    present: (presenting: boolean) => update({ access: { ...state.access, can_moderate: presenting } }),
  };
}

function AnnotationFixture(): React.JSX.Element {
  const [fixture] = useState(createFixture);
  const { width } = useWindowDimensions();
  const frameWidth = Math.min(width - 32, 750);
  const frame = { x: 0, y: 0, width: frameWidth, height: frameWidth * 0.625 };
  const [rendererUrl, setRendererUrl] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);
  const count = useSyncExternalStore(fixture.client.subscribe, fixture.count, fixture.count);
  useEffect(() => {
    let active = true;
    void annotationRendererUrl().then((value) => {
      if (active) setRendererUrl(value);
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (Platform.OS !== "ios" || !presenting) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") void fixture.receiveViewerMark();
    });
    return () => subscription.remove();
  }, [fixture, presenting]);

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Maya’s screen</Text>
      <Text testID="fixture.committed" style={styles.caption}>
        {count} committed marks
      </Text>
      {presenting ? (
        <ShareAnnotationControls annotation={{ client: fixture.client }} publicationId={publicationId} participantId={sharerId} people={[{ id: viewer.id, name: viewer.name, canDraw: false, manages: false }]} />
      ) : (
        <View style={{ width: frame.width, height: frame.height, overflow: "hidden" }}>
          <ScreenAnnotationLayer
            client={fixture.client}
            person={viewer}
            publicationId={publicationId}
            source={rendererUrl ? { rendererUrl, size } : null}
            viewport={frame}
            video={(rect) => (
              <View style={[styles.video, { left: rect.x, top: rect.y, width: rect.width, height: rect.height }]}>
                <View style={styles.leftStripe} />
                <View style={styles.corner} />
                <View style={styles.center} />
                <Text style={styles.videoTitle}>Layout review</Text>
              </View>
            )}
            controls={(tray) => (
              <Portal layer="annotation">
                <View pointerEvents="box-none" style={styles.tray}>
                  {tray}
                </View>
              </Portal>
            )}
          />
        </View>
      )}
      <View style={styles.controls}>
        <Pressable accessibilityRole="button" onPress={fixture.pause}>
          <Text style={styles.caption}>Toggle presenter pause</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={fixture.access}>
          <Text style={styles.caption}>Toggle viewer access</Text>
        </Pressable>
      </View>
      {Platform.OS === "android" || Platform.OS === "ios" ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            fixture.present(!presenting);
            setPresenting(!presenting);
          }}
        >
          <Text style={styles.caption}>{presenting ? "Switch to viewer" : "Switch to sharer"}</Text>
        </Pressable>
      ) : null}
      <PortalHost layer="annotation" />
    </View>
  );
}

export function AnnotationFixtureApp() {
  return (
    <SafeAreaProvider>
      <DeviceLayoutProvider>
        <PortalProvider>
          <ToastProvider>
            <AnnotationFixture />
          </ToastProvider>
        </PortalProvider>
      </DeviceLayoutProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palettes.dark.surface, alignItems: "center", paddingTop: space[22] },
  title: { fontSize: fontSizes.title, fontWeight: "600", color: fixed.overlayText, marginBottom: space[2] },
  caption: { color: palettes.dark.textSoft, marginBottom: space[4] },
  video: { position: "absolute", backgroundColor: palettes.dark.tile },
  leftStripe: { position: "absolute", left: 0, width: "15%", height: "100%", backgroundColor: palettes.dark.raised },
  corner: { position: "absolute", right: 0, top: 0, width: "18%", height: "22%", backgroundColor: palettes.dark.info },
  center: { position: "absolute", left: "50%", top: "50%", width: 6, height: 6, borderRadius: corners.pill, backgroundColor: fixed.overlayText },
  videoTitle: { position: "absolute", left: "20%", top: "25%", fontSize: callType.progress.fontSize, color: fixed.overlayText },
  controls: { flexDirection: "row", gap: space[4], paddingTop: space[5] },
  tray: { position: "absolute", left: 16, right: 16, bottom: 64, maxHeight: "50%", alignItems: "center" },
});
