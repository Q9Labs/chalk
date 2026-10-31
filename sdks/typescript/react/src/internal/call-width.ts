import { createContext, useContext, useLayoutEffect, useState, type RefObject } from "react";

export const PHONE_CALL_WIDTH = 640;
const NarrowCallContext = createContext<boolean | null>(null);
export const NarrowCallProvider = NarrowCallContext.Provider;

/** Whether a call frame's content box is phone width, as the `chalk-call` container rules measure it; null until measured. */
export function useNarrowCallFrame(frame: RefObject<HTMLElement | null>): boolean | null {
  const [narrow, setNarrow] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries: readonly ResizeObserverEntry[] | undefined) => {
      const entry = entries?.[0];
      if (entry) setNarrow(entry.contentRect.width <= PHONE_CALL_WIDTH);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [frame]);
  return narrow;
}

/** Inside a call, whether the call is phone width; null outside a call. */
export function useNarrowCall(): boolean | null {
  return useContext(NarrowCallContext);
}
