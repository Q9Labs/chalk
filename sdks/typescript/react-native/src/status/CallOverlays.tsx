import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { useBackHandler } from "../frame/back-handler";
import { useDeviceLayout } from "../frame/device-layout";
import { frameRegions } from "../frame/regions";
import { useChat, useConnection, useRecording } from "../hooks/space-hooks";
import { ChalkText } from "../primitives/ChalkText";
import { Limbo, type LimboState } from "../limbo/Limbo";
import { Veil, type VeilLevel } from "../limbo/Veil";
import { useToasts } from "../primitives/toast/ToastStack";
import { useTheme } from "../theme/theme";
import type { CallScreen } from "./call-screen";
import { StatusPage } from "./StatusPage";

export type CallOverlaysProps = {
  readonly screen: CallScreen;
  readonly callName: string;
  /** The app restarted to rejoin, so the card says "Rejoining" instead of "Joining". */
  readonly rejoining: boolean;
  /** A phone call has the microphone (T6). */
  readonly onHold: boolean;
  readonly onRejoin: () => void;
  readonly onHome: () => void;
};

/**
 * The overlays layer: a non-blocking connection notice, or a veil while the call joins or waits on a phone
 * call, and the status page once it's over. Android back on a status page goes Home.
 */
export function CallOverlays({ screen, callName, rejoining, onHold, onRejoin, onHome }: CallOverlaysProps): React.JSX.Element {
  const { colors } = useTheme();
  const layout = useDeviceLayout();
  const { header } = frameRegions(layout.arrangement, layout.width, layout.height, layout.insets);
  const connection = useConnection();
  const recording = useRecording().current?.status === "recording";
  const queuedMessages = useChat().pendingSends.filter((send) => send.status === "queued").length;
  useBackHandler(screen.kind === "status", onHome);
  // Notices belong to the live call; a status page or a fresh join starts without them.
  const { clear } = useToasts();
  const clearsNotices = screen.kind === "status" || screen.kind === "joining";
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [transition] Clear shared notices on committed blocking lifecycle transitions, not during an overlay child render.
  useEffect(() => {
    if (clearsNotices) clear();
  }, [clear, clearsNotices]);

  const limbo: LimboState | null = screen.kind === "joining" ? { kind: "joining", rejoining } : screen.kind === "call" && onHold ? { kind: "hold" } : null;
  const veil: VeilLevel = limbo === null ? "none" : limbo.kind === "joining" ? "limbo" : "paused";

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <Veil level={screen.kind === "status" ? "none" : veil} />
      {screen.kind === "reconnecting" || (screen.kind === "call" && connection.syncHealth === "degraded") ? (
        <View pointerEvents="none" style={{ position: "absolute", top: header.y + header.height + 4, left: layout.insets.left + 16, right: layout.insets.right + 16, alignItems: "center" }} testID="connection.notice">
          <ChalkText accessibilityLiveRegion="polite" variant="caption" style={{ backgroundColor: colors.surface, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6 }}>
            {screen.kind === "reconnecting" ? `Reconnecting…${queuedMessages ? ` ${queuedMessages} messages waiting to send.` : ""}` : "Connection is slow"}
          </ChalkText>
        </View>
      ) : null}
      {limbo ? <Limbo callName={callName} recording={recording} state={limbo} /> : null}
      {screen.kind === "status" ? <StatusPage callName={callName} failure={connection.lastError} onHome={onHome} onRejoin={onRejoin} outcome={screen.outcome} /> : null}
    </View>
  );
}
