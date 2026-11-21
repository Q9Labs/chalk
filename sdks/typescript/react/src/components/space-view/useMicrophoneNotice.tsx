import { useState } from "react";
import type { ConnectionStatus, MediaSlice } from "@q9labsai/chalk-client";
import { useSilentMicrophone } from "../../internal/useSilentMicrophone";
import { CallEventIcon } from "../toast-stack/CallEventIcon";
import type { Toast } from "../toast-stack/ToastStack";

const id = "silent-microphone";

export function useMicrophoneNotice(connectionStatus: ConnectionStatus, microphone: MediaSlice["local"]["microphone"]) {
  const [open, setOpen] = useState(false);
  const silent = useSilentMicrophone(connectionStatus === "live" && microphone.state === "enabled" ? microphone.track : null);
  const toasts: Toast[] =
    silent.visible && !open
      ? [
          {
            id,
            type: "warning",
            message: "No input from your microphone.",
            icon: <CallEventIcon kind="microphone-on" />,
            action: { label: "Choose microphone", onClick: () => setOpen(true) },
          },
        ]
      : [];
  return { id, toasts, picker: { open, onOpenChange: setOpen }, dismiss: silent.dismiss };
}
