import { useCallback, useEffect, useRef, useState } from "react";
import { useSpaceClient } from "../../bindings/hooks";
import { callEventToasts, mediaFailureToast } from "./call-events";
import type { Toast } from "./ToastStack";

export function useCallToasts() {
  const client = useSpaceClient();
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const sequence = useRef(0);
  useEffect(() => {
    setToasts([]);
    let previous = client.getSnapshot();
    let failedSource: "microphone" | "camera" | "screen" | undefined;
    const push = (events: readonly Omit<Toast, "id">[]) => {
      if (events.length) setToasts((current) => [...current, ...events.map((event) => ({ ...event, id: `call-event-${++sequence.current}` }))].slice(-20));
    };
    const unsubscribe = client.subscribe(() => {
      const next = client.getSnapshot();
      for (const source of ["microphone", "camera"] as const) if (previous.media.local[source].state !== "failed" && next.media.local[source].state === "failed") failedSource = source;
      if (previous.media.screenShare.state !== "failed" && next.media.screenShare.state === "failed") failedSource = "screen";
      push(callEventToasts(previous, next));
      previous = next;
    });
    const offError = client.on("error", ({ error }) => {
      if (error.code.startsWith("media.")) {
        const toast = mediaFailureToast(error, failedSource);
        if (toast) push([toast]);
      }
      failedSource = undefined;
    });
    return () => {
      unsubscribe();
      offError();
    };
  }, [client]);
  const dismiss = useCallback((id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  return { toasts, dismiss };
}
