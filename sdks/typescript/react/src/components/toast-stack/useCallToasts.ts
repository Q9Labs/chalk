import { useCallback, useEffect, useRef, useState } from "react";
import { useSpaceClient } from "../../bindings/hooks";
import { callEventToasts, mediaFailureToast } from "./call-events";
import type { Toast } from "./ToastStack";

export function useCallToasts() {
  const client = useSpaceClient();
  const [toasts, setToasts] = useState<readonly (Toast & { readonly failureCode?: string })[]>([]);
  const sequence = useRef(0);
  // nosemgrep: chalk.forbid-sdk-use-effect -- Keep existing client notice subscriptions and cleanup.
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
    let disposed = false;
    const offError = client.on("error", ({ error }) => {
      if (!error.code.startsWith("media.")) return;
      // The client emits its error before publishing the changed media snapshot.
      queueMicrotask(() => {
        if (disposed) return;
        const toast = mediaFailureToast(error, failedSource);
        if (toast) {
          const id = `call-event-${++sequence.current}`;
          setToasts((current) => [...current, { ...toast, failureCode: error.code, id }].slice(-20));
        }
        failedSource = undefined;
      });
    });
    return () => {
      disposed = true;
      unsubscribe();
      offError();
    };
  }, [client]);
  const dismiss = useCallback((id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const dismissFailure = useCallback((code: string) => setToasts((current) => current.filter((toast) => toast.failureCode !== code)), []);
  return { toasts, dismiss, dismissFailure };
}
