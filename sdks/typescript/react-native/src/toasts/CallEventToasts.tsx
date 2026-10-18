import { useEffect } from "react";
import { FaceAvatar } from "../avatar/FaceAvatar";
import { useSpaceClient } from "../context/space-client-context";
import { usePreferences } from "../frame/preferences";
import { useToasts } from "../primitives/toast/ToastStack";
import { playSound } from "../sounds/sounds";

/**
 * Turns call events into notices and sounds (owned by the states lane). This minimal version
 * covers people joining and leaving.
 */
export function CallEventToasts(): null {
  const client = useSpaceClient();
  const toasts = useToasts();
  const { soundsEnabled } = usePreferences();
  useEffect(() => {
    const joined = client.on("participantJoined", ({ participant }) => {
      playSound("join", soundsEnabled);
      toasts.show({ leading: <FaceAvatar name={participant.displayName} size={28} />, message: [{ strong: participant.displayName }, " joined"] });
    });
    const left = client.on("participantLeft", ({ participant }) => {
      playSound("leave", soundsEnabled);
      toasts.show({ leading: <FaceAvatar name={participant.displayName} size={28} />, message: [{ strong: participant.displayName }, " left"] });
    });
    return () => {
      joined();
      left();
    };
  }, [client, soundsEnabled, toasts]);
  return null;
}
