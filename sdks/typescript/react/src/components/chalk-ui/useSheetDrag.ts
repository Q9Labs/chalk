import { useRef, type PointerEvent, type RefObject } from "react";
import { useHaptics } from "../../internal/useHaptics";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { releaseSpeed, sheetOffset, SHEET_SETTLE_MS, shouldDismiss, type DragSample } from "./sheet-drag";

interface Drag {
  readonly pointerId: number;
  readonly startY: number;
  readonly height: number;
  readonly samples: DragSample[];
  offset: number;
}

/**
 * Pointer handlers for the part of a bottom sheet that starts a drag (the grabber and the heading).
 * The sheet follows the finger and the scrim fades with it; on release it closes or springs back.
 */
export function useSheetDrag(sheet: RefObject<HTMLElement | null>, scrim: RefObject<HTMLElement | null>, dismiss: () => void) {
  const drag = useRef<Drag | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const { trigger } = useHaptics();

  const settle = (closing: boolean) => {
    const element = sheet.current;
    if (!element) return;
    element.style.transition = reducedMotion ? "none" : `transform ${SHEET_SETTLE_MS}ms var(--chalk-ease-out-expo)`;
    element.style.transform = closing ? "translateY(100%)" : "";
    if (scrim.current) scrim.current.style.opacity = closing ? "0" : "";
    if (closing) {
      void trigger("success");
      dismiss();
      return;
    }
    // Give the sheet's own transitions back once it has sprung home.
    window.setTimeout(
      () => {
        element.style.transition = "";
      },
      reducedMotion ? 0 : SHEET_SETTLE_MS,
    );
  };

  const start = (event: PointerEvent<HTMLElement>) => {
    const element = sheet.current;
    if (!element || event.button !== 0 || (event.target instanceof Element && event.target.closest("button, a, input"))) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { pointerId: event.pointerId, startY: event.clientY, height: element.getBoundingClientRect().height, samples: [{ time: event.timeStamp, y: event.clientY }], offset: 0 };
  };

  const move = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    const element = sheet.current;
    if (!current || !element || event.pointerId !== current.pointerId) return;
    current.offset = sheetOffset(event.clientY - current.startY);
    current.samples.push({ time: event.timeStamp, y: event.clientY });
    element.style.transition = "none";
    element.style.transform = `translateY(${current.offset}px)`;
    if (scrim.current) scrim.current.style.opacity = String(Math.max(0, 1 - Math.max(0, current.offset) / current.height));
  };

  const end = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    drag.current = null;
    // A pause before the release counts: the speed is measured up to the release itself.
    current.samples.push({ time: event.timeStamp, y: event.clientY });
    settle(event.type === "pointerup" && shouldDismiss(current.offset, current.height, releaseSpeed(current.samples)));
  };

  return { onPointerDown: start, onPointerMove: move, onPointerUp: end, onPointerCancel: end };
}
