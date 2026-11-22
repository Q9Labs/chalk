import { useState } from "react";
import type { failedMediaNotice } from "../control-bar/control-bar-behavior";
import type { Toast } from "../toast-stack/ToastStack";

const id = "media-notice";

/** A microphone or camera that failed without an access card gets one notice in the call's stack, above the dock, until it recovers or is dismissed. */
export function useMediaNotice(failed: ReturnType<typeof failedMediaNotice>, retry: (device: "microphone" | "camera") => void) {
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  const message = failed?.message;
  const toasts: Toast[] =
    failed && message !== dismissed
      ? [
          {
            id,
            type: "error",
            duration: Infinity,
            message: failed.message,
            action: { label: "Try again", onClick: () => failed.devices.forEach(retry) },
          },
        ]
      : [];
  return { id, toasts, dismiss: () => setDismissed(message) };
}
