import type { ScreenAnnotationClient, ScreenAnnotationFrameSize, ScreenAnnotationState } from "@q9labsai/chalk-client";
import { createAnnotationPresenceTracker } from "@q9labsai/chalk-screen-annotation";
import { useEffect, useState } from "react";
import { NativeEventEmitter, NativeModules, StyleSheet, View } from "react-native";
import { ChalkText } from "../primitives/ChalkText";
import { useToasts } from "../primitives/toast/ToastStack";
import { useTheme } from "../theme/theme";
import { corners, space } from "../theme/tokens";
import { ToolButton } from "./ScreenAnnotationToolbar";
import { paintAnnotationPiP } from "./pip-paint";

type Ink = ReturnType<typeof paintAnnotationPiP>;

type AnnotationPiP = {
  supported(): Promise<boolean>;
  start(publicationId: string, trackId: string, width: number, height: number, ink: Ink): Promise<boolean>;
  update(publicationId: string, ink: Ink): void;
  stop(publicationId: string): void;
  addListener(event: string): void;
  removeListeners(count: number): void;
};

function previewSize(frame: ScreenAnnotationFrameSize) {
  const scale = 480 / Math.max(frame.width, frame.height);
  return { x: 0, y: 0, width: Math.max(2, Math.round(frame.width * scale)), height: Math.max(2, Math.round(frame.height * scale)) };
}

export function ShareAnnotationPiP({ client, layer, trackId }: { readonly client: ScreenAnnotationClient; readonly layer: ScreenAnnotationState["layer"]; readonly trackId?: string }) {
  const native = NativeModules.ChalkAnnotationPiP as AnnotationPiP | undefined;
  const { colors } = useTheme();
  const toasts = useToasts();
  const [supported, setSupported] = useState(false);
  const [prompt, setPrompt] = useState(true);
  const [phase, setPhase] = useState<"idle" | "starting" | "active">("idle");
  const { publication_id: publicationId, layer_id: layerId, frame } = layer;

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] Stop the native window and detach its callbacks when this share is replaced or ends.
  useEffect(() => {
    if (!native) return;
    let live = true;
    void native
      .supported()
      .then((available) => {
        if (live) setSupported(available);
      })
      .catch(() => {});
    const stopped = new NativeEventEmitter(native).addListener("chalkAnnotationPiPStopped", (id: unknown) => {
      if (id === publicationId) setPhase("idle");
    });
    return () => {
      live = false;
      stopped.remove();
      native.stop(publicationId);
    };
  }, [native, publicationId]);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Stream Sync scene changes to the active native window independently of React rendering.
  useEffect(() => {
    if (!native || phase !== "active") return;
    const sink = native;
    const tracker = createAnnotationPresenceTracker();
    const rect = previewSize(frame);
    let next: ReturnType<typeof setTimeout> | undefined;
    const paint = () => {
      next = undefined;
      const snapshot = client.getSnapshot();
      if (snapshot.status !== "ready" || snapshot.state?.layer.layer_id !== layerId) {
        tracker.clear();
        sink.update(publicationId, []);
        return;
      }
      const { state } = snapshot;
      const now = client.serverNowMs();
      const presence = tracker.update(snapshot.presence, now);
      sink.update(publicationId, paintAnnotationPiP(rect, state, presence, now));
      // Keep time-based ink moving even if the drawers stop sending updates.
      const expires = state.marks.some((mark) => mark.expires_at_ms !== null && mark.expires_at_ms > now);
      if (presence.length || expires) next = setTimeout(paint, 100);
    };
    const unsubscribe = client.subscribe(() => {
      next ??= setTimeout(paint, 67);
    });
    paint();
    return () => {
      unsubscribe();
      clearTimeout(next);
    };
  }, [native, phase, client, layerId, publicationId, frame]);

  if (!native || !supported) return null;

  const start = async () => {
    const snapshot = client.getSnapshot();
    if (snapshot.status !== "ready" || snapshot.state?.layer.layer_id !== layerId) return;
    setPrompt(false);
    setPhase("starting");
    const rect = previewSize(frame);
    const ink = paintAnnotationPiP(rect, snapshot.state, snapshot.presence, client.serverNowMs());
    const started = await native.start(publicationId, trackId ?? "", rect.width, rect.height, ink).catch(() => false);
    setPhase(started ? "active" : "idle");
    const current = client.getSnapshot();
    if (!started && current.status === "ready" && current.state?.layer.layer_id === layerId) {
      toasts.show({ kind: "error", dismissible: true, message: "Picture-in-picture couldn’t start. Try again." });
    }
  };

  if (prompt) {
    return (
      <View style={[styles.prompt, { backgroundColor: colors.raised }]}>
        <ChalkText>Keep viewers’ marks in view while you share, even in other apps.</ChalkText>
        <View style={styles.actions}>
          <ToolButton label="Not now" onPress={() => setPrompt(false)} />
          <ToolButton label="Start" accessibilityLabel="Start picture-in-picture" icon="pip" selected onPress={() => void start()} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.actions}>
      {phase === "starting" ? <ChalkText>Opening picture-in-picture…</ChalkText> : <ToolButton label={phase === "active" ? "Close picture-in-picture" : "Picture-in-picture"} icon="pip" selected={phase === "active"} onPress={() => (phase === "active" ? native.stop(publicationId) : void start())} />}
    </View>
  );
}

const styles = StyleSheet.create({
  prompt: { width: "100%", maxWidth: 320, borderRadius: corners["2xl"], padding: space[3], gap: space[2] },
  actions: { flexDirection: "row", width: "100%", maxWidth: 320, gap: space[1] },
});
