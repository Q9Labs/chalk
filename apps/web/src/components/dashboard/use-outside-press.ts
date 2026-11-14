import { useEffect, useRef, type RefObject } from "react";

/** Calls `onOutside` when a pointer goes down outside `wrap` while `open`. */
export function useOutsidePress(open: boolean, wrap: RefObject<HTMLElement | null>, onOutside: () => void) {
  const latest = useRef(onOutside);
  latest.current = onOutside;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrap.current?.contains(event.target)) latest.current();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, wrap]);
}
