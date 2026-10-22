import { useState } from "react";
import { Platform } from "react-native";
import { useSpaceClient } from "../context/space-client-context";
import { useCan, useMedia } from "../hooks/space-hooks";
import { SheetRow } from "../primitives/SheetGroup";
import { useToasts } from "../primitives/toast/ToastStack";

export function ScreenShareRow({ onDone }: { readonly onDone: () => void }): React.JSX.Element | null {
  const client = useSpaceClient();
  const media = useMedia();
  const canShare = useCan("publishScreen");
  const toasts = useToasts();
  const [pending, setPending] = useState(false);
  const sharing = media.screenShare.state === "enabled";
  if ((!canShare && !sharing) || (Platform.OS !== "ios" && Platform.OS !== "android")) return null;

  const toggle = async () => {
    if (pending) return;
    setPending(true);
    try {
      await client.media.setScreenShareEnabled(!sharing);
      onDone();
    } catch {
      toasts.show({ kind: "error", dismissible: true, message: sharing ? "Couldn't stop sharing your screen." : "Couldn't share your screen. Check screen recording permission and try again." });
    } finally {
      setPending(false);
    }
  };

  return <SheetRow icon={sharing ? "shareOff" : "monitor"} label={pending ? (sharing ? "Stopping screen share…" : "Starting screen share…") : sharing ? "Stop sharing screen" : "Share screen"} onPress={() => void toggle()} testID="more.screenShare" />;
}
