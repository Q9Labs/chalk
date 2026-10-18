import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { useBackHandler } from "../frame/back-handler";
import { useChat, useRecording } from "../hooks/space-hooks";
import { Limbo, type LimboState } from "../limbo/Limbo";
import { Veil, type VeilLevel } from "../limbo/Veil";
import { useToasts } from "../primitives/toast/ToastStack";
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
 * The overlays layer: the veil and limbo card while the call joins, reconnects or waits on a phone
 * call, and the status page once it's over. Android back on a status page goes Home.
 */
export function CallOverlays({ screen, callName, rejoining, onHold, onRejoin, onHome }: CallOverlaysProps): React.JSX.Element {
  const recording = useRecording().current?.status === "recording";
  const queuedMessages = useChat().pendingSends.filter((send) => send.status === "queued").length;
  useBackHandler(screen.kind === "status", onHome);
  // Notices belong to the live call; a status page or a fresh join starts without them.
  const { clear } = useToasts();
  const clearsNotices = screen.kind === "status" || screen.kind === "joining";
  useEffect(() => {
    if (clearsNotices) clear();
  }, [clear, clearsNotices]);

  const limbo: LimboState | null = screen.kind === "joining" ? { kind: "joining", rejoining } : screen.kind === "reconnecting" ? { kind: "reconnecting", queuedMessages } : screen.kind === "call" && onHold ? { kind: "hold" } : null;
  const veil: VeilLevel = limbo === null ? "none" : limbo.kind === "joining" ? "limbo" : "paused";

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <Veil level={screen.kind === "status" ? "none" : veil} />
      {limbo ? <Limbo callName={callName} recording={recording} state={limbo} /> : null}
      {screen.kind === "status" ? <StatusPage callName={callName} onHome={onHome} onRejoin={onRejoin} outcome={screen.outcome} /> : null}
    </View>
  );
}
