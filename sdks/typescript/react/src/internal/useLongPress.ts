import { useRef, type MouseEvent, type PointerEvent } from "react";
import { useHaptics } from "./useHaptics";

export const LONG_PRESS_MS = 400;
/** A finger that moves this far is scrolling or dragging, not holding. */
const LONG_PRESS_SLOP = 10;

/**
 * Handlers for a button that does one thing on tap and another on a 400 ms hold.
 * After a hold fires, the click that follows the release is swallowed, so the tap action does not also run.
 */
export function useLongPress(onLongPress: (() => void) | undefined) {
  const timer = useRef<number | undefined>(undefined);
  const origin = useRef({ x: 0, y: 0 });
  const fired = useRef(false);
  const { trigger } = useHaptics();
  const cancel = () => window.clearTimeout(timer.current);
  if (!onLongPress) return undefined;
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      fired.current = false;
      origin.current = { x: event.clientX, y: event.clientY };
      cancel();
      timer.current = window.setTimeout(() => {
        fired.current = true;
        void trigger("medium");
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > LONG_PRESS_SLOP) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu: (event: MouseEvent<HTMLElement>) => event.preventDefault(),
  };
}
