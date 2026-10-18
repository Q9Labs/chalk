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
    const push = (events: readonly Omit<Toast, "id">[]) => {
      if (events.length) setToasts((current) => [...current, ...events.map((event) => ({ ...event, id: `call-event-${++sequence.current}` }))].slice(-20));
    };
    const unsubscribe = client.subscribe(() => {
      const next = client.getSnapshot();
      push(callEventToasts(previous, next));
      previous = next;
    });
    const offError = client.on("error", ({ error }) => {
      const snapshot = client.getSnapshot();
      const source = snapshot.media.screenShare.state === "failed" ? "screen" : snapshot.media.local.camera.state === "failed" ? "camera" : "microphone";
      push([mediaFailureToast(error, source)]);
    });
    return () => {
      unsubscribe();
      offError();
    };
  }, [client]);
  const dismiss = useCallback((id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  return { toasts, dismiss };
}
