import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { StageBox } from "./stage-layout";

/** A card and its resized tiles must commit before the same browser paint. */
export function useStageDimensions(fallback: StageBox) {
  const ref = useRef<HTMLDivElement>(null);
  const current = useRef(fallback);
  const [dimensions, setDimensions] = useState(fallback);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const style = getComputedStyle(element);
    const initial = {
      width: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      height: element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
    };
    if (initial.width > 0 && initial.height > 0) {
      current.current = initial;
      setDimensions(initial);
    }
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0 || (width === current.current.width && height === current.current.height)) return;
      const next = { width, height };
      current.current = next;
      // ResizeObserver is outside React. A deferred update can paint the card
      // over the old strip for a frame before the FLIP snapshot is committed.
      flushSync(() => setDimensions(next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, dimensions };
}
