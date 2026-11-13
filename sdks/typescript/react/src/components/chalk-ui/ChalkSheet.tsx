import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CallLimboContext } from "../../internal/call-limbo-context";
import { useSheetDrag } from "./useSheetDrag";
export interface ChalkSheetProps {
  /** `reactions` has no scrim, so what floats over the call stays bright. */
  readonly variant?: "default" | "details" | "panel" | "reactions" | "stage";
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly accessibleLabel?: string;
  readonly children: ReactNode;
}
/**
 * Base UI owns the focus trap, Escape, outside press and return to the opener.
 * A drag that starts on the grabber or the heading closes the sheet, past 30% of its height or on a flick.
 * The details sheet can open on its own at call start, so it focuses itself, not its close button: no ring shows, and Tab reaches the first control.
 */
export function ChalkSheet({ open: requested, onOpenChange, title, accessibleLabel, children, variant = "default" }: ChalkSheetProps) {
  const open = requested && !useContext(CallLimboContext);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const drag = useSheetDrag(popup, scrim, () => onOpenChange(false));
  // A sheet dragged shut and reopened before its exit ends is the same popup: give it back from the drag's offset.
  useLayoutEffect(() => {
    if (!open) return;
    if (popup.current) {
      popup.current.style.transform = "";
      popup.current.style.transition = "";
    }
    if (scrim.current) scrim.current.style.opacity = "";
  }, [open]);
  const attach = useCallback((element: HTMLElement | null) => setContainer(element?.closest<HTMLElement>("[data-chalk]") ?? element), []);
  return (
    <span ref={attach} style={{ display: "contents" }}>
      <Dialog.Root
        open={open}
        onOpenChange={(next, details) => {
          // The reactions sheet has no scrim, so a tap on a call notice's button must reach the notice and leave the sheet open.
          const reached = details.event instanceof FocusEvent ? details.event.relatedTarget : details.event.target;
          if (variant === "reactions" && (details.reason === "outside-press" || details.reason === "focus-out") && reached instanceof Element && reached.closest(".chalk-toasts")) {
            details.cancel();
            return;
          }
          onOpenChange(next);
        }}
        modal={variant !== "reactions"}
      >
        {container ? (
          <Dialog.Portal container={container}>
            {variant === "reactions" ? null : <Dialog.Backdrop ref={scrim} data-part="sheet-scrim" className="chalk-sheet-scrim" />}
            <Dialog.Popup
              ref={popup}
              {...(accessibleLabel ? { "aria-label": accessibleLabel, "aria-labelledby": undefined } : {})}
              initialFocus={variant === "details" ? popup : undefined}
              data-part={variant === "panel" ? "panel-card" : "sheet"}
              data-variant={variant}
              className="chalk-sheet"
            >
              <div data-part="sheet-handle" data-sheet-drag className="chalk-sheet-handle" {...drag} />
              {variant !== "details" ? (
                <Dialog.Title className="sr-only">{title}</Dialog.Title>
              ) : (
                <div data-sheet-drag className="chalk-sheet-heading" {...drag}>
                  <Dialog.Title>{title}</Dialog.Title>
                  <Dialog.Close data-part="sheet-dismiss" className="chalk-dismiss" aria-label="Close">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m6 6 12 12M6 18 18 6" />
                    </svg>
                  </Dialog.Close>
                </div>
              )}
              {variant === "default" || variant === "details" || variant === "reactions" ? <div className="chalk-sheet-body">{children}</div> : children}
            </Dialog.Popup>
          </Dialog.Portal>
        ) : null}
      </Dialog.Root>
    </span>
  );
}
