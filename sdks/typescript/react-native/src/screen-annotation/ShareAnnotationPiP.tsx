import type { ScreenAnnotationClient } from "@q9labsai/chalk-client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { NativeEventEmitter, NativeModules, Platform, StyleSheet, View } from "react-native";
import { ChalkText } from "../primitives/ChalkText";
import { useToasts } from "../primitives/toast/ToastStack";
import { useTheme } from "../theme/theme";
import { corners, space } from "../theme/tokens";
import { ToolButton } from "./ScreenAnnotationToolbar";
import { createShareAnnotationPiPSession, type AnnotationPiP, type PiPShareSource } from "./share-annotation-pip-session";

const hidden = { trackId: null, phase: "idle" } as const;
const getHidden = () => hidden;
const subscribeHidden = () => () => undefined;

export function useShareAnnotationPiP(source: PiPShareSource, client: ScreenAnnotationClient) {
  const native = Platform.OS === "ios" ? (NativeModules.ChalkAnnotationPiP as AnnotationPiP | undefined) : undefined;
  const session = useMemo(() => (native ? createShareAnnotationPiPSession(source, client, native) : null), [source, client, native]);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] Follow the local broadcast independently of the mounted controls or the Sync replica.
  useEffect(() => {
    if (!session || !native) return;
    const stopped = new NativeEventEmitter(native).addListener("chalkAnnotationPiPStopped", session.stopped);
    const detach = session.attach();
    return () => {
      stopped.remove();
      detach();
    };
  }, [session, native]);
  const state = useSyncExternalStore(session?.subscribe ?? subscribeHidden, session?.getSnapshot ?? getHidden, session?.getSnapshot ?? getHidden);
  return session && state.trackId ? { session, state } : null;
}

export type ShareAnnotationPiPControls = NonNullable<ReturnType<typeof useShareAnnotationPiP>>;

export function ShareAnnotationPiP({ session, state }: ShareAnnotationPiPControls) {
  const { colors } = useTheme();
  const toasts = useToasts();
  const [prompt, setPrompt] = useState(true);

  const start = async () => {
    setPrompt(false);
    if ((await session.start()) === false) {
      toasts.show({ kind: "error", dismissible: true, message: "Picture-in-picture couldn’t start. Try again." });
    }
  };

  if (prompt && state.phase === "idle") {
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
      {state.phase === "starting" ? (
        <ChalkText>Opening picture-in-picture…</ChalkText>
      ) : (
        <ToolButton label={state.phase === "active" ? "Close picture-in-picture" : "Picture-in-picture"} icon="pip" selected={state.phase === "active"} onPress={() => (state.phase === "active" ? session.stop() : void start())} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  prompt: { width: "100%", maxWidth: 320, borderRadius: corners["2xl"], padding: space[3], gap: space[2] },
  actions: { flexDirection: "row", width: "100%", maxWidth: 320, gap: space[1] },
});
