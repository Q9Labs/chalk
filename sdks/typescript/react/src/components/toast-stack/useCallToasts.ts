import { runMediaAction } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSpaceClient } from "../../bindings/hooks";
import { callEventToasts, mediaFailureToast } from "./call-events";
import type { Toast } from "./ToastStack";

export function useCallToasts() {
  const client = useSpaceClient();
  const [toasts, setToasts] = useState<readonly (Toast & { readonly failureCode?: string })[]>([]);
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
    let disposed = false;
    const offError = client.on("error", ({ error }) => {
      if (!error.code.startsWith("media.")) return;
      // The client emits its error before publishing the changed media snapshot.
      queueMicrotask(() => {
        if (disposed) return;
        const toast = mediaFailureToast(error, failedSource);
        if (toast) {
          const id = `call-event-${++sequence.current}`;
          const action =
            failedSource === "screen" && error.recoverable
              ? {
                  label: "Try again",
                  onClick: () => {
                    // The client error event owns any retry failure and its sound.
                    void runMediaAction(client, true, () => client.media.setScreenShareEnabled(true)).then(
                      (applied) => {
                        if (applied) setToasts((current) => current.filter((event) => event.id !== id));
                      },
                      () => undefined,
                    );
                  },
                }
              : undefined;
          setToasts((current) => [...current, { ...toast, action, failureCode: error.code, id }].slice(-20));
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
